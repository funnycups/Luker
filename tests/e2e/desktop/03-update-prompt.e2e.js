// The desktop update path, driven the way a user hits it: the backend
// compares the running version against a release served by a real HTTP
// stub, the prompt appears in the shell, and confirming hands the asset to
// the preload bridge, which downloads it into the data root.
//
// The stub stands in for the release host (an external service), never for
// the code under test: the endpoint, the prompt and the bridge all run for
// real. `LUKER_DESKTOP_SKIP_OPEN_INSTALLER` keeps the download from actually
// handing a file to the OS installer.

import { test, expect } from '../../harness/playwright.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startReleaseStub } from '../_lib/releaseStub.js';
import { launchLukerDesktop } from '../_lib/desktop.js';
import { awaitMainUI } from '../_lib/page.js';
import { markOnboarded } from '../_lib/fixtures.js';

// Cases 1 and 2 share one shell on purpose: the prompt is consumed the moment
// it is confirmed, so the assertion that it is offered and the assertion that
// confirming downloads the file have to run against the same window in order.
test.describe.configure({ mode: 'serial' });

const ASSET_NAME = `Luker-9.9.9-mac-${process.arch}.dmg`;
const ASSET_BYTES = 'luker-desktop-update-payload';

let stub;
let desktop;

function updatePrompt(page) {
    return page.locator('dialog.popup[open]', { hasText: 'A Luker update is available.' });
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    stub = await startReleaseStub({
        tag: '9.9.9',
        assets: [{ name: ASSET_NAME, url: `/download/${ASSET_NAME}`, size: Buffer.byteLength(ASSET_BYTES) }],
        assetBody: ASSET_BYTES,
    });
    desktop = await launchLukerDesktop({
        scope,
        scenarioId: 'update-prompt',
        extraEnv: {
            LUKER_GITHUB_API_BASE: stub.baseURL,
            LUKER_DESKTOP_SKIP_OPEN_INSTALLER: '1',
        },
    });
    // The shell follows the host locale for its UI. Pin English the same way
    // the language dropdown does — write the stored preference — so the
    // prompt's user-visible strings are the ones asserted here.
    await desktop.page.addInitScript(() => { localStorage.setItem('language', 'en'); });
    markOnboarded({ dataRoot: desktop.dataRoot });
    await awaitMainUI(desktop.page, desktop.baseURL);
});

test.afterAll(async () => {
    await desktop?.close();
    await stub?.stop();
});

test('the update prompt offers the desktop download', async () => {
    const dialog = updatePrompt(desktop.page);
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog).toContainText('running inside the desktop app');
    await expect(dialog).toContainText('Current source');
    await expect(dialog.locator('.popup-button-ok')).toHaveText('Download Update');
});

test('confirming downloads the installer into the data root', async () => {
    await updatePrompt(desktop.page).locator('.popup-button-ok').click();
    const destination = join(desktop.userData, 'updates', ASSET_NAME);
    await expect.poll(() => existsSync(destination), { timeout: 30_000 }).toBe(true);
    expect(readFileSync(destination)).toEqual(Buffer.from(ASSET_BYTES));
});

test('a relaunch clears the installer an earlier run downloaded', async () => {
    const destination = join(desktop.userData, 'updates', ASSET_NAME);
    expect(existsSync(destination)).toBe(true);

    // The OS owns the installer once it has been handed over, so the copy under
    // the data root is only staging: the next launch drops whatever is left.
    await desktop.relaunch();
    await awaitMainUI(desktop.page, desktop.baseURL);

    expect(existsSync(destination)).toBe(false);
});

test('a failing asset download is reported, not swallowed', async ({ resources }) => {
    stub.setAssetStatus(404);
    const failing = await launchLukerDesktop({
        scope: resources,
        scenarioId: 'update-failure',
        extraEnv: {
            LUKER_GITHUB_API_BASE: stub.baseURL,
            LUKER_DESKTOP_SKIP_OPEN_INSTALLER: '1',
        },
    });
    await failing.page.addInitScript(() => { localStorage.setItem('language', 'en'); });
    markOnboarded({ dataRoot: failing.dataRoot });
    await awaitMainUI(failing.page, failing.baseURL);
    await updatePrompt(failing.page).locator('.popup-button-ok').click();
    const progress = failing.page.locator('dialog.popup[open]', { hasText: 'Update failed.' });
    await expect(progress).toBeVisible({ timeout: 30_000 });
    await expect(progress.locator('.lukerUpdateStatus')).toHaveText('Update failed.');
    await expect(progress.locator('.lukerUpdateLogs')).toHaveValue(/404/);
    await expect.poll(() => existsSync(join(failing.userData, 'updates', ASSET_NAME))).toBe(false);

    await failing.close();
});

test('the shell reports how it was installed', async () => {
    // This run is a checkout on macOS, so it is neither a self-contained
    // Linux bundle nor a Linux package: the shell must report no flavour.
    expect(await desktop.page.evaluate(() => window.LukerDesktop.installFlavour)).toBe('');
});

test('a release with no asset for this install opens the release page', async ({ resources }) => {
    // The stub is swapped to serve only a build for another platform, so the
    // endpoint reports no matching asset. Downloads are restored to 200, so an
    // attempt to fetch one would leave a file behind and the assertions below
    // would see it.
    stub.setAssets([{
        name: 'Luker-9.9.9-linux-x86_64.AppImage',
        url: '/download/Luker-9.9.9-linux-x86_64.AppImage',
        size: Buffer.byteLength(ASSET_BYTES),
    }]);
    stub.setAssetStatus(200);

    const noAsset = await launchLukerDesktop({
        scope: resources,
        scenarioId: 'update-no-asset',
        extraEnv: {
            LUKER_GITHUB_API_BASE: stub.baseURL,
            LUKER_DESKTOP_SKIP_OPEN_INSTALLER: '1',
            LUKER_DESKTOP_SKIP_OPEN_EXTERNAL: '1',
        },
    });
    await noAsset.page.addInitScript(() => { localStorage.setItem('language', 'en'); });
    markOnboarded({ dataRoot: noAsset.dataRoot });
    await awaitMainUI(noAsset.page, noAsset.baseURL);
    await updatePrompt(noAsset.page).locator('.popup-button-ok').click();

    const releasePageUrl = `${stub.baseURL}/releases/tag/9.9.9`;
    await expect.poll(() => noAsset.electronApp.evaluate(() => globalThis.__lukerExternalOpens ?? []))
        .toEqual([releasePageUrl]);
    expect(existsSync(join(noAsset.userData, 'updates', ASSET_NAME))).toBe(false);

    await noAsset.close();
});

test('replacing a running bundle in place asks the user to restart', async ({ resources }) => {
    // A self-contained Linux bundle names its own path through the
    // environment, so pointing that at a scratch file drives the replace-in-
    // place branch on any platform: the download is renamed over the file the
    // process was started from, and the running process keeps the old one
    // until the user restarts.
    stub.setAssets([{ name: ASSET_NAME, url: `/download/${ASSET_NAME}`, size: Buffer.byteLength(ASSET_BYTES) }]);
    stub.setAssetStatus(200);

    const bundleDir = (await resources.directory('desktop bundle update')).path;
    const bundlePath = join(bundleDir, 'Luker-9.9.9-linux-x86_64.AppImage');
    writeFileSync(bundlePath, 'the bundle that is currently running');

    const appimage = await launchLukerDesktop({
        scope: resources,
        scenarioId: 'update-appimage',
        extraEnv: {
            LUKER_GITHUB_API_BASE: stub.baseURL,
            LUKER_DESKTOP_SKIP_OPEN_INSTALLER: '1',
            APPIMAGE: bundlePath,
        },
    });
    await appimage.page.addInitScript(() => { localStorage.setItem('language', 'en'); });
    markOnboarded({ dataRoot: appimage.dataRoot });
    await awaitMainUI(appimage.page, appimage.baseURL);
    await updatePrompt(appimage.page).locator('.popup-button-ok').click();

    const progress = appimage.page.locator('dialog.popup[open]', { has: appimage.page.locator('.lukerUpdateStatus') });
    await expect(progress.locator('.lukerUpdateStatus'))
        .toHaveText('Replaced in place. Restart Luker to run the new version.', { timeout: 30_000 });
    expect(readFileSync(bundlePath)).toEqual(Buffer.from(ASSET_BYTES));

    await appimage.close();
});
