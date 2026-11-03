import { test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { openPersonaPanel } from '../_lib/ui-persona-preset.js';
import { accountWindow, openAccountTab } from '../_lib/account-window.js';

const PERSONA_NAME = 'Mira';
const PERSONA_DESCRIPTION = 'A cartographer charting the northern coast.';
const PROFILE_NAME = 'Coastal archive';
const API_KEY = 'onboarding-import-test-key';
const onboarding = page => page.locator('dialog[open]').filter({ has: page.locator('.onboarding') });

let scratchRoot, source, mock, backupPath, expectedSettings, expectedSecrets;

test.describe.configure({ mode: 'default' });

function readSettings(server) {
    return JSON.parse(readFileSync(join(server.dataRoot, 'default-user/settings.json'), 'utf8'));
}

function readSecrets(server) {
    return JSON.parse(readFileSync(join(server.dataRoot, 'default-user/secrets.json'), 'utf8'));
}

async function startFreshServer(name) {
    const dataRoot = join(scratchRoot, name);
    mkdirSync(dataRoot);
    return startServer({
        batchKey: 'personas',
        scenarioId: `onboarding-${name}`,
        useExistingDataRoot: dataRoot,
        extraConfig: {
            enableUserAccounts: false,
            allowKeysExposure: true,
            globalExtensionsPath: join(scratchRoot, 'global-extensions'),
            serverPluginsPath: join(scratchRoot, 'server-plugins'),
        },
    });
}

test.beforeAll(async ({ browser }) => {
    scratchRoot = mkdtempSync(resolve(import.meta.dirname, '../../.e2e-scratch/onboarding-import-'));
    mock = await startMockLLM({});
    source = await startFreshServer('source');
    backupPath = join(scratchRoot, 'backup.zip');
    const page = await browser.newPage();
    try {
        await page.goto(source.baseURL);
        const welcome = onboarding(page);
        await welcome.locator('.popup-input').fill(PERSONA_NAME);
        await welcome.locator('.popup-button-ok').click();
        await expect(welcome).toHaveCount(0);
        await page.waitForFunction(() => performance.getEntriesByName('[init] complete').length > 0);

        await openPersonaPanel(page);
        await page.locator('#persona_description').fill(PERSONA_DESCRIPTION);
        await page.locator('#persona_description').blur();
        await page.locator('#persona-management-button .drawer-toggle').click();

        await page.locator('#API-status-top').click();
        await page.locator('#main_api').selectOption('openai');
        await page.locator('#chat_completion_source').selectOption('custom');
        await page.locator('#custom_api_url_text').fill(mock.baseURL);
        await page.locator('#custom_model_id').fill('mock-gpt-4o');
        await page.locator('#api_key_custom').fill(API_KEY);
        const secretSaved = page.waitForResponse(r => r.url().endsWith('/api/secrets/write') && r.ok());
        await page.locator('#api_button_openai').click();
        await secretSaved;

        await page.locator('#create_connection_profile').click();
        const profilePopup = page.locator('dialog[open]').last();
        await profilePopup.locator('.popup-input').fill(PROFILE_NAME);
        await profilePopup.locator('.popup-button-ok').click();
        await expect.poll(() => readSettings(source).extension_settings?.connectionManager?.profiles)
            .toEqual(expect.arrayContaining([expect.objectContaining({ name: PROFILE_NAME, 'api-url': mock.baseURL })]));
        const settings = readSettings(source);
        expectedSettings = {
            firstRun: false,
            username: PERSONA_NAME,
            user_avatar: settings.user_avatar,
            main_api: 'openai',
            oai_settings: { chat_completion_source: 'custom', custom_url: mock.baseURL, custom_model: 'mock-gpt-4o' },
            power_user: {
                personas: { [settings.user_avatar]: PERSONA_NAME },
                persona_descriptions: { [settings.user_avatar]: { description: PERSONA_DESCRIPTION } },
            },
            extension_settings: { connectionManager: settings.extension_settings.connectionManager },
        };
        expect(settings).toMatchObject(expectedSettings);
        expectedSecrets = readSecrets(source);
        expect(expectedSecrets.api_key_custom).toEqual(expect.arrayContaining([expect.objectContaining({ value: API_KEY })]));

        await page.locator('#API-status-top').click();
        await openAccountTab(page, 'backup');
        const download = page.waitForEvent('download');
        await accountWindow(page).locator('[data-act="backup-go"]').click();
        await (await download).saveAs(backupPath);
    } finally {
        await page.close();
    }
});

test.afterAll(async () => {
    await tearDownServer(source);
    await mock?.stop();
    if (scratchRoot) rmSync(scratchRoot, { recursive: true, force: true });
});

test('finishing onboarding preserves imported API connections, secrets and personas', async ({ page }) => {
    const destination = await startFreshServer('destination');
    try {
        await page.goto(destination.baseURL);
        const welcome = onboarding(page);
        await welcome.locator('.popup-input').fill('Fresh desktop');
        const imported = page.waitForResponse(r => r.url().endsWith('/api/users/import/data-zip'));
        await welcome.locator('.onboardingImportDataZipInput').setInputFiles(backupPath);
        expect((await imported).ok()).toBe(true);
        await expect(welcome.locator('.onboardingImportDataZipButton')).not.toHaveClass(/disabled/);
        expect(readSettings(destination)).toMatchObject(expectedSettings);

        await welcome.locator('.popup-button-ok').click();
        await expect(welcome).toHaveCount(0);
        // The old onboarding continuation saved the fresh browser defaults
        // over the restored settings when the user dismissed the welcome popup.
        await expect.poll(() => readSettings(destination)).toMatchObject(expectedSettings);
        expect(readSecrets(destination)).toEqual(expectedSecrets);
        await expect(page.locator('#your_name')).toHaveText(PERSONA_NAME);
        await openPersonaPanel(page);
        await expect(page.locator('#persona_description')).toHaveValue(PERSONA_DESCRIPTION);

        await page.reload();
        await expect(page.locator('#your_name')).toHaveText(PERSONA_NAME);
        expect(readSettings(destination)).toMatchObject(expectedSettings);
    } finally {
        await tearDownServer(destination);
    }
});

test('onboarding cannot finish while a data import is pending', async ({ page }) => {
    const destination = await startFreshServer('pending-import');
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    try {
        // Delay only transport. The request still reaches the real import
        // endpoint and its response is neither replaced nor modified.
        await page.route('**/api/users/import/data-zip', async route => {
            started.resolve();
            await release.promise;
            await route.continue();
        });
        await page.goto(destination.baseURL);
        const welcome = onboarding(page);
        await welcome.locator('.popup-input').fill('Fresh desktop');
        const imported = page.waitForResponse(r => r.url().endsWith('/api/users/import/data-zip'));
        await welcome.locator('.onboardingImportDataZipInput').setInputFiles(backupPath);
        await started.promise;
        await welcome.locator('.popup-button-ok').click();
        await expect(welcome).not.toHaveAttribute('closing');
        await page.keyboard.press('Escape');
        await expect(welcome).not.toHaveAttribute('closing');

        release.resolve();
        expect((await imported).ok()).toBe(true);
        await expect(welcome.locator('.onboardingImportDataZipButton')).not.toHaveClass(/disabled/);
        await welcome.locator('.popup-button-ok').click();
        await expect(welcome).toHaveCount(0);
        await expect(page.locator('#your_name')).toHaveText(PERSONA_NAME);
        expect(readSettings(destination)).toMatchObject(expectedSettings);
    } finally {
        release.resolve();
        await page.unrouteAll({ behavior: 'wait' });
        await tearDownServer(destination);
    }
});

test('a rejected archive still allows normal onboarding to save the new persona', async ({ page }) => {
    const destination = await startFreshServer('failed-import');
    try {
        await page.goto(destination.baseURL);
        const welcome = onboarding(page);
        await welcome.locator('.popup-input').fill('Fresh desktop');
        const imported = page.waitForResponse(r => r.url().endsWith('/api/users/import/data-zip'));
        await welcome.locator('.onboardingImportDataZipInput').setInputFiles({
            name: 'invalid.zip',
            mimeType: 'application/zip',
            buffer: Buffer.from('not a ZIP archive'),
        });
        expect((await imported).ok()).toBe(false);
        await expect(welcome.locator('.onboardingImportDataZipButton')).not.toHaveClass(/disabled/);
        await welcome.locator('.popup-button-ok').click();
        await expect.poll(() => readSettings(destination)).toMatchObject({
            firstRun: false,
            username: 'Fresh desktop',
        });
        await page.reload();
        await expect(page.locator('#your_name')).toHaveText('Fresh desktop');
        await expect(onboarding(page)).toHaveCount(0);
    } finally {
        await tearDownServer(destination);
    }
});
