import { test, expect } from '@playwright/test';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { s3Fixture, backendRow, createReadyWorldBook, selectReadyWorldBook } from '../_lib/sync-s3.js';
import { addWorldEntry } from '../_lib/ui-worldinfo.js';
import { addS3Backend, waitForBackendSync, closeAllPopups, openLanSyncPanel, clickSyncNow, waitForSyncPopup, closeSyncPopup, syncPopup, chooseConflictVersion, applyConflictChoices, waitForStatusChecks } from '../_lib/sync.js';
import { accountWindow, closeAccountWindow } from '../_lib/account-window.js';
import { selectCharacterByName, closeAnyOpenTopSettingsDrawer, openTopDrawer, closeTopDrawer, openExtensionsDrawer, openInlineDrawer, closeExtensionsDrawer } from '../_lib/page.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { importCharacterFile } from '../_lib/ui-character.js';

const fixture = s3Fixture(test);
test.describe.configure({ timeout: 300_000 });
const pill = page => page.locator('#luker-sync-activity-pill');
/** The Resolve button the Sync page shows while sync issues wait. */
const reviewButton = page => accountWindow(page).locator('.dw-banner [data-act="conflicts"]');
const checks = page => page.evaluate(() => Number(document.body.dataset.syncStatusChecks || 0));
const observe = promise => promise.then(value => ({ value }), error => ({ error }));
async function result(promise) {
    const settled = await promise;
    if (settled.error) throw settled.error;
    return settled.value;
}
function gate() {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    return { promise, release };
}
async function reached(promise) {
    let arrived = false;
    const settled = observe(promise.then(() => { arrived = true; }));
    await expect.poll(() => arrived, { timeout: 60_000 }).toBe(true);
    await result(settled);
}
function syncResponse(page, id) {
    return observe((async () => {
        const response = await page.waitForResponse(response => new URL(response.url()).pathname === `/api/sync/v1/backends/${id}/sync`, { timeout: 90_000 });
        return { status: response.status(), body: await response.json() };
    })());
}

async function addCloud(page, options) {
    await addS3Backend(page, options);
    await waitForBackendSync(page, { label: options.label });
    return backendRow(page, options.label).getAttribute('data-backend');
}

async function closePopupButtons(page) {
    const dialogs = page.locator('dialog.popup[open]');
    while (await dialogs.count()) {
        const id = await dialogs.last().getAttribute('data-id');
        await dialogs.last().locator('.popup-button-ok').click();
        await expect(page.locator(`dialog.popup[data-id="${id}"]`)).toHaveCount(0);
    }
    // The Account window closes with its own close button.
    await closeAccountWindow(page);
}

async function assertPlacement(page) {
    const boxes = await page.locator('.activity-pill:visible').evaluateAll(elements => elements.map(element => {
        const r = element.getBoundingClientRect();
        return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    }));
    expect(boxes).toHaveLength(2);
    const [a, b] = boxes;
    expect(a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y).toBe(true);
    const topBar = await page.locator('#top-settings-holder').boundingBox();
    const input = await page.locator('#send_textarea').boundingBox();
    const viewport = page.viewportSize();
    for (const box of boxes) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.right).toBeLessThanOrEqual(viewport.width);
        expect(box.y).toBeGreaterThanOrEqual(topBar.y + topBar.height);
        expect(box.bottom).toBeLessThan(input.y);
        expect(box.height).toBeGreaterThan(20);
    }
    await expect(page.locator('.activity-pill-host')).toHaveCount(1);
}

test('manual S3 activity owns the real request through window closure and late status until settlement', async ({ browser }, testInfo) => {
    const { page, server } = await fixture.device(browser, 'activity-request');
    expect(server.execArgv.includes('--jitless')).toBe(process.env.LUKER_SYNC_ACCEPTANCE_JITLESS === '1');
    const proxy = await fixture.proxy();
    const options = { ...await fixture.options(), endpoint: proxy.endpoint, label: 'Harbor cloud' };
    const id = await addCloud(page, options);
    await expect(reviewButton(page)).toHaveCount(0);
    const storage = proxy.addFault({ match: { method: 'GET', keySuffix: '/head' }, hold: 'before-forward' });
    const responseGate = gate(), captured = gate();
    const handlers = [];
    await page.route(`**/api/sync/v1/backends/${id}/sync`, route => {
        const handled = observe((async () => {
            const response = await route.fetch({ timeout: 0 });
            captured.release();
            await responseGate.promise;
            await route.fulfill({ response });
        })());
        handlers.push(handled);
        return result(handled);
    });
    const response = syncResponse(page, id);
    try {
        await backendRow(page, options.label).locator('[data-act="sync-now"]').click();
        await expect(pill(page)).toContainText(options.label, { timeout: 2000 });
        await expect(pill(page).getByRole('progressbar')).toBeVisible();
        await expect(pill(page)).not.toContainText(/\d+%/);
        await reached(storage.reached);
        await closeAllPopups(page);
        await closeAnyOpenTopSettingsDrawer(page);
        await page.locator('#send_textarea').fill('*The navigator keeps the lantern shaded.* "Wait for the harbor signal."');
        await page.locator('#send_textarea').focus();
        await waitForStatusChecks(page, await checks(page) + 1);
        await expect(page.locator('#send_textarea')).toBeFocused();
        await expect(page.locator('#send_textarea')).toHaveValue(/harbor signal/);
        await expect(accountWindow(page)).toHaveCount(0);
        await pill(page).dblclick();
        await expect(accountWindow(page)).toHaveCount(1);
        await expect(backendRow(page, options.label)).toHaveClass(/\blocked\b/);
        await closeAllPopups(page);
        await pill(page).focus();
        await page.keyboard.press('Enter');
        await expect(accountWindow(page)).toHaveCount(1);
        storage.release();
        await reached(captured.promise);
        await waitForStatusChecks(page, await checks(page) + 1);
        await expect(pill(page).getByRole('progressbar')).toBeVisible();
        await expect(backendRow(page, options.label)).toHaveClass(/\blocked\b/);
        responseGate.release();
        expect(await result(response)).toMatchObject({ status: 200, body: { ok: true, lastSync: { error: null }, pendingConflicts: 0, stalled: null } });
        await expect(pill(page)).toBeHidden({ timeout: 15_000 });
        await closeAllPopups(page);
        await testInfo.attach('actual-server-argv', { body: JSON.stringify(server.execArgv), contentType: 'application/json' });
    } finally {
        storage.release(); responseGate.release();
        const settlements = await Promise.all([response, ...handlers]);
        await page.unroute(`**/api/sync/v1/backends/${id}/sync`);
        const errors = settlements.flatMap(settled => settled.error ? [settled.error] : []);
        expect(errors, 'Sync activity response and route cleanup must settle without errors').toEqual([]);
    }
});

test('storage and status-network errors retain backend evidence through unrelated success and recover without reload', async ({ browser }) => {
    const { page } = await fixture.device(browser, 'activity-failures');
    const proxy = await fixture.proxy();
    const options = { ...await fixture.options(), endpoint: proxy.endpoint, label: 'Storm cloud' };
    const id = await addCloud(page, options);
    const other = { ...await fixture.options(), label: 'Calm mirror' };
    await addCloud(page, other);
    for (const failure of ['dropConnection', 'invalidSignature']) {
        const fault = proxy.addFault({ match: { method: 'GET', keySuffix: '/keyinfo.json' }, [failure]: true });
        const response = syncResponse(page, id);
        try {
            await openLanSyncPanel(page);
            await backendRow(page, options.label).locator('[data-act="sync-now"]').click();
            expect((await result(response)).body).toMatchObject({ ok: false, code: failure === 'invalidSignature' ? 'AUTH_FAILED' : 'UNREACHABLE' });
            await expect(pill(page)).toHaveAttribute('data-tone', 'error');
            await expect(pill(page)).toContainText(options.label);
            expect(await clickSyncNow(page, other.label)).toBe('success');
            await expect(pill(page)).toContainText(options.label);
            await expect(pill(page)).toHaveAttribute('data-tone', 'error');
        } finally { fault.cancel(); await result(response); }
    }
    const network = async route => { await route.fetch(); await route.abort('connectionfailed'); };
    await page.route('**/api/sync/v1/status', network);
    try {
        await waitForStatusChecks(page, await checks(page) + 1);
        await expect(pill(page)).toHaveAttribute('data-tone', 'unknown');
        await expect(pill(page)).toContainText(options.label);
        await expect(accountWindow(page).locator('.dw-banner.error', { hasText: 'Can\'t read sync status' })).toBeVisible();
    } finally { await page.unroute('**/api/sync/v1/status', network); }
    await waitForStatusChecks(page, await checks(page) + 1);
    await expect(pill(page)).toHaveAttribute('data-tone', 'error');
    await closeAllPopups(page);
    await closeAnyOpenTopSettingsDrawer(page);
    await page.route('**/api/sync/v1/categories', network);
    try {
        // The window opens on Sync and says why sync cannot be shown.
        await pill(page).click();
        await expect(accountWindow(page).locator('.dw-empty')).toContainText('Could not load sync categories');
        await expect(backendRow(page, options.label)).toHaveCount(0);
        await expect(pill(page)).toBeVisible();
        await closeAccountWindow(page);
        await expect(accountWindow(page)).toHaveCount(0);
    } finally { await page.unroute('**/api/sync/v1/categories', network); }
    await pill(page).click();
    await expect(accountWindow(page)).toHaveCount(1);
    await expect(backendRow(page, options.label)).toHaveAttribute('data-state', 'error');
    await expect(backendRow(page, options.label).locator('.dw-card-note.bad')).toBeVisible();
    expect(await clickSyncNow(page, options.label)).toBe('success');
    await expect(pill(page)).toBeHidden({ timeout: 15_000 });
});

test('closed genuine conflicts retain the capsule and review through the Sync issues page in all locales', async ({ browser }) => {
    const a = await fixture.device(browser, 'activity-conflict-a');
    const b = await fixture.device(browser, 'activity-conflict-b');
    const options = { ...await fixture.options(), label: 'Grove archive' };
    await addCloud(a.page, options);
    await closeAllPopups(a.page);
    await createReadyWorldBook(a.page, 'Lantern Grove');
    await openLanSyncPanel(a.page);
    expect(await clickSyncNow(a.page, options.label)).toBe('success');
    await addCloud(b.page, options);
    for (const [device, key, content] of [[a, 'lantern', 'The lantern keeper waits beneath the eastern oak.'], [b, 'beacon', 'The western beacon answers through the rain.']]) {
        await closeAllPopups(device.page);
        await device.page.reload();
        await device.page.waitForFunction(() => performance.getEntriesByName('[init] complete').length > 0);
        await selectReadyWorldBook(device.page, 'Lantern Grove');
        await addWorldEntry(device.page, { key, content });
    }
    await openLanSyncPanel(a.page); expect(await clickSyncNow(a.page, options.label)).toBe('success');
    await openLanSyncPanel(b.page); expect(await clickSyncNow(b.page, options.label)).toBe('warning');
    await waitForSyncPopup(b.page);
    await closeSyncPopup(b.page);
    await expect(pill(b.page)).toHaveAttribute('data-tone', 'attention');
    for (const [locale, review, activity] of [
        ['en', 'Resolve', 'Sync needs attention'],
        ['zh-cn', '去处理', '同步需要处理'],
        ['zh-tw', '去處理', '同步需要處理'],
    ]) {
        await closeAllPopups(b.page);
        if (locale !== 'en') {
            await openTopDrawer(b.page, 'user-settings-button');
            await Promise.all([b.page.waitForEvent('load', { timeout: 30_000 }), b.page.locator('#ui_language_select').selectOption(locale)]);
            await b.page.waitForFunction(() => performance.getEntriesByName('[init] complete').length > 0);
            await waitForSyncPopup(b.page);
            await closeSyncPopup(b.page);
        }
        await expect(pill(b.page)).toContainText(activity);
        await pill(b.page).click();
        await expect(accountWindow(b.page)).toHaveCount(1);
        await accountWindow(b.page).getByRole('button', { name: review, exact: true }).click();
        await waitForSyncPopup(b.page);
        await expect(syncPopup(b.page).locator('.dw-conflict-head b')).toHaveText('worlds/Lantern Grove.json');
        await closeSyncPopup(b.page);
    }
    await pill(b.page).click();
    await accountWindow(b.page).getByRole('button', { name: '去處理', exact: true }).click();
    await waitForSyncPopup(b.page);
    await chooseConflictVersion(b.page, 'worlds/Lantern Grove.json', 'current');
    expect(await applyConflictChoices(b.page)).toBe('success');
    await waitForStatusChecks(b.page, await checks(b.page) + 1);
    await expect(pill(b.page)).toBeHidden({ timeout: 15_000 });
});

async function upstreamGate(mock) {
    const barrier = gate(), captured = gate();
    let armed = false;
    const jobs = [];
    const server = http.createServer((request, response) => {
        const job = observe((async () => {
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            const upstream = await fetch(new URL(request.url, mock.baseURL), { method: request.method, headers: request.headers, body: request.method === 'POST' ? Buffer.concat(chunks) : undefined });
            const bytes = Buffer.from(await upstream.arrayBuffer());
            if (armed && request.url.endsWith('/chat/completions')) {
                armed = false;
                captured.release();
                await barrier.promise;
            }
            response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') });
            response.end(bytes);
        })());
        jobs.push(job);
        result(job).catch(error => { response.destroy(error); });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { baseURL: `http://127.0.0.1:${server.address().port}/v1`, arm() { armed = true; }, reached: captured.promise, release: barrier.release,
        async close() {
            barrier.release();
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
            const errors = (await Promise.all(jobs)).flatMap(settled => settled.error ? [settled.error] : []);
            if (errors.length) throw new AggregateError(errors, 'Upstream activity fixture cleanup failed');
        } };
}

test('real orchestration and Sync share desktop and narrow placement with long labels and reduced motion', async ({ browser }, testInfo) => {
    const { page, server } = await fixture.device(browser, 'activity-coexist');
    const abortRequests = [];
    page.on('request', request => {
        if (/\/api\/generation\/[^/]+\/abort$/.test(new URL(request.url()).pathname)) abortRequests.push(request.url());
    });
    const mock = await startMockLLM({});
    const upstream = await upstreamGate(mock);
    const proxy = await fixture.proxy();
    const label = 'Lighthouse archive — northern passage charts and lantern keeper records';
    const options = { ...await fixture.options(), endpoint: proxy.endpoint, label };
    let storage, response;
    const final = '*Seraphina folds the chart against the wind.* "The lighthouse has answered. Follow the green lanterns; I will meet you at the harbor gate."';
    try {
        const id = await addCloud(page, options);
        await closeAllPopups(page);
        await closeAnyOpenTopSettingsDrawer(page);
        await importCharacterFile(page, { filePath: fileURLToPath(new URL('../../../default/content/default_Seraphina.png', import.meta.url)), expectedName: 'Seraphina' });
        await selectCharacterByName(page, 'Seraphina');
        await openTopDrawer(page, 'sys-settings-button');
        await page.locator('#main_api').selectOption('openai');
        await page.locator('#chat_completion_source').selectOption('custom');
        await page.locator('#custom_api_url_text').fill(upstream.baseURL);
        await page.locator('#custom_api_url_text').blur();
        await page.locator('#custom_model_id').fill('mock-gpt-4o');
        await page.locator('#custom_model_id').blur();
        await page.locator('#api_button_openai').click();
        await expect(page.locator('#sys-settings-button .online_status_text:visible')).not.toHaveText('No connection...');
        await closeTopDrawer(page, 'sys-settings-button');
        await openExtensionsDrawer(page);
        await openInlineDrawer(page, 'orchestrator_settings');
        await page.locator('#luker_orch_enabled').check();
        await page.locator('#luker_orch_execution_mode').selectOption('director');
        await page.locator('#orchestrator_settings .luker-tabs-tab[data-luker-tab-key="general"]').click();
        await page.locator('#luker_orch_llm_api_preset').selectOption('');
        await page.locator('#luker_orch_llm_preset').selectOption('');
        const chooser = page.waitForEvent('filechooser');
        await page.locator('#orchestrator_settings [data-luker-preset-action="import"][data-mode="director"]').click();
        await (await chooser).setFiles({ name: 'lighthouse-director.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ mode: 'director', profile: { mode: 'director', name: 'Lighthouse watch', mainAgent: { systemPrompt: 'Guide Seraphina through the harbor watch. Use write_message for her reply and finalize when it is ready.', apiPresetName: '', promptPresetName: '', skills: { visible: [], deny: [] } }, subAgents: [], tools: {}, maxRounds: 4, skills: { visible: [], deny: [] } } })) });
        const imported = page.locator('dialog.popup[open]').last();
        await imported.locator('.popup-input').fill('Lighthouse watch');
        await imported.locator('.popup-button-ok').click();
        await expect(page.locator('#orchestrator_settings [data-luker-preset-select][data-mode="director"] option:checked')).toHaveText('Lighthouse watch');
        await closeExtensionsDrawer(page);
        mock.scriptDirectorRun({ route: ({ role, turn }) => role === 'director-main' ? turn === 0 ? { text: '*She studies the green lanterns beyond the reef.*', tool: 'write_message', arguments: { text: final, mode: 'replace' } } : { tool: 'finalize', arguments: {} } : null });
        upstream.arm();
        await page.locator('#send_textarea').fill('*I steady the lantern against the rain.* "Has the lighthouse answered us?"');
        await page.locator('#send_but').click();
        await page.getByRole('button', { name: 'Save and continue', exact: true }).click();
        await reached(upstream.reached);
        const run = page.locator('#luker-orch-run-panel');
        await expect(run).toHaveAttribute('data-state', 'open');
        await run.locator('[data-action="close"]').click();
        await openLanSyncPanel(page);
        storage = proxy.addFault({ match: { method: 'GET', keySuffix: '/head' }, hold: 'before-forward' });
        response = syncResponse(page, id);
        await backendRow(page, label).locator('[data-act="sync-now"]').click();
        await reached(storage.reached);
        await closePopupButtons(page);
        await closeAnyOpenTopSettingsDrawer(page);
        expect(abortRequests).toEqual([]);
        await expect(page.locator('#luker-orch-run-panel-pill')).toBeVisible();
        await expect(page.locator('#chat .mes_text').first()).not.toBeEmpty();
        for (const [name, viewport, reducedMotion] of [
            ['desktop', { width: 1440, height: 1000 }, 'no-preference'],
            ['narrow-reduced-motion', { width: 390, height: 844 }, 'reduce'],
        ]) {
            await page.setViewportSize(viewport);
            await page.emulateMedia({ reducedMotion });
            await pill(page).focus();
            await page.keyboard.press('Tab');
            await expect(page.locator('#luker-orch-run-panel-pill')).toBeFocused();
            await page.keyboard.press('Shift+Tab');
            await expect(pill(page)).toBeFocused();
            await assertPlacement(page);
            await expect(pill(page)).toHaveAttribute('aria-label', new RegExp(label));
            await expect(pill(page)).not.toContainText(/\d+%/);
            if (reducedMotion === 'reduce') expect(await pill(page).locator('.activity-pill-progress').evaluate(element => getComputedStyle(element, '::after').animationName)).toBe('none');
            await page.screenshot({ path: testInfo.outputPath(`sync-run-${name}.png`), fullPage: true });
        }
        await page.locator('#luker-orch-run-panel-pill').click();
        await expect(run).toHaveAttribute('data-state', 'open');
        await expect(page.locator('#luker-orch-run-panel-pill')).toBeHidden();
        await run.locator('[data-action="close"]').click();
        upstream.release();
        await expect(page.locator('#chat .last_mes .mes_text')).toContainText('The lighthouse has answered', { timeout: 60_000 });
        await expect(page.locator('#luker-orch-run-panel-pill')).toBeHidden();
        await expect(pill(page)).toBeVisible();
        storage.release();
        expect((await result(response)).body.ok).toBe(true);
        await expect(pill(page)).toBeHidden({ timeout: 15_000 });
        await testInfo.attach('actual-server-argv', { body: JSON.stringify(server.execArgv), contentType: 'application/json' });
    } finally {
        upstream.release(); storage?.release();
        try {
            if (response) await result(response);
        } finally {
            try { await upstream.close(); } finally { await mock.stop(); }
        }
    }
});
