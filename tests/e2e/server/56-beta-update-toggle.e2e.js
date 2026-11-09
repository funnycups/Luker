// The user-settings switch that lets update checks consider beta and RC
// releases. The release host is a real HTTP stub; the update check, the
// settings write, and the prompt all run through their normal paths. The
// running version stays ahead of the stub's stable tag, so the prompt can
// only come from the prerelease on the list endpoint.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startReleaseStub } from '../_lib/releaseStub.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';

const STABLE_TAG = '0.0.1';
const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../package.json'), 'utf8'));
const [major, minor] = pkg.version.match(/^(\d+)\.(\d+)/).slice(1).map(Number);
const RC_TAG = `${major}.${minor + 1}.0-rc.1`;

let server;
let stub;

async function openUserSettings(page) {
    const drawerClosed = await page.locator('#user-settings-button .drawer-icon.closedIcon').count().then(n => n > 0);
    if (drawerClosed) {
        await page.locator('#user-settings-button .drawer-toggle').click();
    }
    await page.waitForFunction(() => {
        const el = document.getElementById('user-settings-block');
        return el && !el.classList.contains('closedDrawer');
    }, { timeout: 5_000 });
}

function updatePrompt(page) {
    return page.locator('dialog.popup[open]', { hasText: 'A Luker update is available.' });
}

function listRequests() {
    return stub.requests.filter(request => request.path.endsWith('/releases'));
}

async function toggleBetaUpdates(page, checked) {
    await openUserSettings(page);
    const checkbox = page.locator('#luker_check_beta_updates');
    await expect(checkbox).toBeVisible();
    const saved = page.waitForResponse(response => {
        const path = new URL(response.url()).pathname;
        return (path === '/api/settings/save' || path === '/api/settings/patch')
            && response.request().method() === 'POST';
    });
    if (checked) {
        await checkbox.check();
    } else {
        await checkbox.uncheck();
    }
    await saved;
}

test.beforeAll(async () => {
    stub = await startReleaseStub({
        tag: STABLE_TAG,
        releases: [STABLE_TAG, RC_TAG],
    });
    server = await startServer({
        batchKey: 'server',
        scenarioId: 'beta-update-toggle',
        extraEnv: { LUKER_GITHUB_API_BASE: stub.baseURL },
    });
    markOnboarded({ dataRoot: server.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await stub?.stop();
});

test('the switch decides whether update checks consider prereleases', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);

    // Default: the switch is on, so the client asks for the release list and
    // the RC ahead of the running version opens the update prompt.
    await expect(page.locator('#luker_check_beta_updates')).toBeChecked();
    await expect(updatePrompt(page)).toBeVisible({ timeout: 30_000 });
    expect(listRequests().length).toBeGreaterThan(0);
    await updatePrompt(page).locator('.popup-button-cancel').first().click();

    // Turn it off through the real checkbox and confirm the setting is saved.
    await toggleBetaUpdates(page, false);

    stub.clearRequests();
    const uncheckedCheck = page.waitForResponse(response =>
        new URL(response.url()).pathname === '/api/system/update-check');
    await reloadAndAwait(page, server.baseURL);
    await uncheckedCheck;

    await expect(page.locator('#luker_check_beta_updates')).not.toBeChecked();
    await expect(updatePrompt(page)).toHaveCount(0);
    expect(listRequests()).toHaveLength(0);

    // Turn it back on; after the reload the list endpoint is queried again and
    // the RC prompt returns.
    await toggleBetaUpdates(page, true);

    stub.clearRequests();
    const checkedCheck = page.waitForResponse(response =>
        new URL(response.url()).pathname === '/api/system/update-check');
    await reloadAndAwait(page, server.baseURL);
    await checkedCheck;

    await expect(page.locator('#luker_check_beta_updates')).toBeChecked();
    await expect(updatePrompt(page)).toBeVisible({ timeout: 30_000 });
    expect(listRequests().length).toBeGreaterThan(0);
});
