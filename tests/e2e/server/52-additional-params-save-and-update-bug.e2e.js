// #52 — "Save and Update" popup silently skips updateConnectionProfile
// when the exclude list is unchanged, causing Additional Parameters to
// be lost on the next profile switch.
//
// Repro (user-reported flow):
//   1. Select profile A. Open the Additional Parameters dialog
//      (#customize_additional_parameters), set a truthy value into
//      #custom_include_body, and close. This writes to
//      oai_settings.custom_include_body but NOT to profile A yet.
//   2. Open the pencil-icon "Save and Update" popup on A. All checkboxes
//      are already ticked (default state). Click the "Save and Update"
//      custom button. Because newExcludeList matches profile.exclude,
//      the guarded block at index.js:1837 skips updateConnectionProfile
//      entirely. Profile A's stored `custom-include-body` is NEVER
//      snapshotted from oai_settings.
//   3. Switch to profile B via the #connection_profiles dropdown.
//      applyConnectionProfile(B) writes B's `custom-include-body` (which
//      is either an empty string, an old truthy value, or undefined)
//      back into oai_settings — clobbering A's live value X.
//   4. Do the same "clear then Save and Update" motion on B for symmetry
//      with the user's report.
//   5. Switch back to A via the dropdown. applyConnectionProfile(A) reads
//      A's stored `custom-include-body` (which was never updated in step
//      2, so it is still "") and writes "" to oai_settings. Opening the
//      Additional Parameters dialog on A now shows an empty field: the
//      value X the user "saved" has vanished.
//
// Expected: after step 5, oai_settings.custom_include_body === "X" (the
// value the user set on profile A and confirmed via "Save and Update").
// Observed: it is "" — the save silently no-op'd.

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, openExtensionsDrawer, closeAnyOpenTopSettingsDrawer } from '../_lib/page.js';

let server, mockA, mockB;

const CUSTOM_INCLUDE_BODY_A = '{"reasoning": {"effort": "high"}}';

function seedTwoProfiles({ dataRoot, urlA, urlB }) {
    const settingsPath = resolve(dataRoot, 'default-user', 'settings.json');
    const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
    s.extension_settings = s.extension_settings || {};
    const baseProfile = {
        id: 'pid-A',
        name: 'mock-A',
        api: 'custom',
        mode: 'cc',
        preset: '',
        model: 'mock-gpt-4o',
        proxy: 'None',
        instruct: '',
        context: '',
        sysprompt: '',
        'sysprompt-state': false,
        'instruct-state': false,
        tokenizer: '',
        'stop-strings': '',
        'start-reply-with': '',
        'custom-models': '',
        // Both profiles seeded with empty additional-params fields so the
        // repro exactly matches the user's starting condition (no leftover
        // values on either profile).
        'custom-include-body': '',
        'custom-exclude-body': '',
        'custom-include-headers': '',
        exclude: [],
        'api-url': urlA,
    };
    const profileA = { ...baseProfile };
    const profileB = { ...baseProfile, id: 'pid-B', name: 'mock-B', 'api-url': urlB };
    s.extension_settings.connectionManager = {
        profiles: [profileA, profileB],
        selectedProfile: 'pid-A',
    };
    writeFileSync(settingsPath, JSON.stringify(s, null, 4));
}

test.beforeAll(async () => {
    mockA = await startMockLLM({});
    mockB = await startMockLLM({});
    server = await startServer({ batchKey: 'server', scenarioId: 'additional-params-save-bug' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mockA.baseURL });
    seedTwoProfiles({ dataRoot: server.dataRoot, urlA: mockA.baseURL, urlB: mockB.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mockA?.stop();
    await mockB?.stop();
});

/**
 * Open the top-nav "API Connections" panel (#rm_api_block, opened via
 * the #API-status-top plug icon). The Additional Parameters button and
 * the pencil-icon edit button both live here — they are not in the
 * Extensions drawer.
 */
async function openApiPanel(page) {
    const drawer = page.locator('#rm_api_block');
    // If it's already open (has openDrawer class), no-op.
    if (await drawer.evaluate(el => el.classList.contains('openDrawer')).catch(() => false)) {
        return;
    }
    await closeAnyOpenTopSettingsDrawer(page).catch(() => {});
    const icon = page.locator('#API-status-top');
    await icon.waitFor({ state: 'visible', timeout: 10_000 });
    await icon.click();
    await page.waitForFunction(() => {
        const el = document.querySelector('#rm_api_block');
        return !!el && el.classList.contains('openDrawer');
    }, null, { timeout: 10_000 });
}

/**
 * Select a connection profile via the real #connection_profiles dropdown.
 * See tests/e2e/server/43-profile-isolation.e2e.js for why we drive
 * the change via jQuery instead of Playwright's selectOption (select2
 * wraps the underlying <select> and hides it).
 */
async function selectProfileFromDropdown(page, profileName) {
    // The #connection_profiles dropdown is inside the connection-manager
    // block that lives at the top of #rm_api_block. Open that panel.
    await openApiPanel(page);
    const sel = page.locator('#connection_profiles');
    await sel.waitFor({ state: 'attached', timeout: 10_000 });
    await page.waitForFunction((name) => {
        const s = document.querySelector('#connection_profiles');
        if (!s) return false;
        return Array.from(s.options).some(o => o.textContent === name);
    }, profileName, { timeout: 10_000 });
    await page.evaluate(async (name) => {
        const s = document.querySelector('#connection_profiles');
        const opt = Array.from(s.options).find(o => o.textContent === name);
        if (!opt) throw new Error(`profile option "${name}" not found`);
        const $ = window.jQuery;
        $(s).val(opt.value);
        $(s).trigger('change');
    }, profileName);
    // Wait for the manager to register the selection.
    await page.waitForFunction((name) => {
        const ctx = window.Luker?.getContext?.();
        const cm = ctx?.extensionSettings?.connectionManager;
        if (!cm) return false;
        const sel = cm.profiles?.find(p => p.id === cm.selectedProfile);
        return sel?.name === name;
    }, profileName, { timeout: 10_000 });
    // Let applyConnectionProfile's slash-command chain complete and the
    // debounced settings save flush.
    await page.waitForTimeout(2500);
}

/**
 * Open the Additional Parameters dialog via the real #customize_additional_parameters
 * button, fill #custom_include_body via a real input event (so the
 * onCustomizeParametersClick input handler at openai.js:8735 fires and
 * writes into oai_settings + saveSettingsDebounced), then dismiss the
 * dialog via its OK button. Waits for the dialog to close so subsequent
 * clicks don't race with popup animations.
 */
async function setIncludeBodyViaDialog(page, value) {
    await openApiPanel(page);
    const openBtn = page.locator('#customize_additional_parameters');
    await openBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await openBtn.click();

    const includeBody = page.locator('#custom_include_body').last();
    await includeBody.waitFor({ state: 'visible', timeout: 10_000 });
    // Clear then type — either way must fire the 'input' event that
    // openai.js:8735 listens on.
    await includeBody.fill('');
    if (value.length > 0) {
        await includeBody.fill(value);
    } else {
        // Trigger a fresh input event even for the clear case so
        // saveSettingsDebounced runs.
        await includeBody.dispatchEvent('input');
    }
    // Close the dialog by clicking the OK button of the topmost popup.
    const okBtn = page.locator('dialog.popup[open] .popup-button-ok').last();
    await okBtn.click();
    await page.waitForFunction(() => {
        return !document.querySelector('dialog.popup[open]');
    }, null, { timeout: 5000 });
    // Let the debounce flush.
    await page.waitForTimeout(1500);
}

/**
 * Open the pencil-icon "Save and Update" popup (edit.html) on the
 * currently-selected profile, leave the checkboxes as they are, and
 * click the "Save and Update" custom button. This is the exact flow the
 * user described: "会显示完成保存数据范围的那个弹窗,勾选了附加参数".
 */
async function clickSaveAndUpdatePopup(page) {
    await openApiPanel(page);
    const editBtn = page.locator('#edit_connection_profile');
    await editBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await editBtn.click();

    // Wait for the popup with the "Included settings" checkboxes.
    const popup = page.locator('dialog.popup[open]').last();
    await popup.waitFor({ state: 'visible', timeout: 10_000 });
    await popup.locator('input[name="exclude"]').first().waitFor({ state: 'attached', timeout: 5000 });

    // Sanity: the "Include Body Parameters" checkbox should exist and be
    // checked (the user's "他勾选了附加参数" precondition — nothing was
    // excluded).
    const includeBodyCheckbox = popup.locator('input[name="exclude"][value="Include Body Parameters"]');
    await expect(includeBodyCheckbox).toBeVisible();
    await expect(includeBodyCheckbox).toBeChecked();

    // Click the "Save and Update" custom button (index.js:1807).
    const saveAndUpdate = popup.locator('.popup-button-custom').filter({ hasText: /save and update/i }).first();
    await saveAndUpdate.click();

    await page.waitForFunction(() => {
        return !document.querySelector('dialog.popup[open]');
    }, null, { timeout: 5000 });
    // Let the (skipped-in-the-buggy-path) settings save flush.
    await page.waitForTimeout(1500);
}

function readLiveIncludeBody(page) {
    return page.evaluate(() => {
        const ctx = window.Luker?.getContext?.();
        // Both names exist on ctx depending on init timing; prefer the
        // documented chatCompletionSettings, fall back to the raw
        // oaiSettings / oai_settings surfaces.
        const s = ctx?.chatCompletionSettings || ctx?.oaiSettings || ctx?.oai_settings;
        return String(s?.custom_include_body ?? '');
    });
}

function readProfileIncludeBody(page, profileName) {
    return page.evaluate((name) => {
        const ctx = window.Luker?.getContext?.();
        const p = ctx?.extensionSettings?.connectionManager?.profiles?.find(x => x.name === name);
        return p ? String(p['custom-include-body'] ?? '') : null;
    }, profileName);
}

test.describe('#52 — "Save and Update" popup drops Additional Parameters when exclude list unchanged', () => {
    test('setting custom-include-body on A and clicking "Save and Update" then switching to B and back loses the value', async ({ page }) => {
        test.setTimeout(180_000);
        await awaitMainUI(page, server.baseURL);

        // Confirm A is active (seed already set selectedProfile = pid-A).
        await selectProfileFromDropdown(page, 'mock-A');

        // Step 1 — set X into Additional Params dialog on A.
        await setIncludeBodyViaDialog(page, CUSTOM_INCLUDE_BODY_A);

        // Sanity: live oai_settings now holds X.
        expect(await readLiveIncludeBody(page)).toBe(CUSTOM_INCLUDE_BODY_A);
        // Profile A has NOT been snapshotted yet — this is expected because
        // the Additional Params dialog only writes to oai_settings.
        expect(await readProfileIncludeBody(page, 'mock-A')).toBe('');

        // Step 2 — open pencil-icon popup on A, leave checkboxes unchanged,
        // click "Save and Update".
        await clickSaveAndUpdatePopup(page);

        // The user believes A has been saved. Ideally, profile A now stores X.
        // In the buggy code, the popup skipped updateConnectionProfile because
        // exclude list didn't change, so profile A still holds "".
        const profileAAfterSave = await readProfileIncludeBody(page, 'mock-A');

        // Step 3 — switch to B via dropdown.
        await selectProfileFromDropdown(page, 'mock-B');

        // Step 4 — replicate user's second-profile motion (clear then
        // "Save and Update") on B. This mirrors "然后切换到另一个,进行同样
        // 的操作,但随后又清除了这个 api 连接配置的附加参数并再次保存".
        await setIncludeBodyViaDialog(page, ''); // clear (no-op vs empty, but fires input)
        await clickSaveAndUpdatePopup(page);

        // Step 5 — switch back to A.
        await selectProfileFromDropdown(page, 'mock-A');

        // The critical assertion: after returning to A, the value the user
        // saved should still be there.
        const liveAfterReturn = await readLiveIncludeBody(page);
        const profileAAfterReturn = await readProfileIncludeBody(page, 'mock-A');

        console.log('[#52] profile A custom-include-body after "Save and Update":', JSON.stringify(profileAAfterSave));
        console.log('[#52] profile A custom-include-body after A→B→A round-trip:', JSON.stringify(profileAAfterReturn));
        console.log('[#52] live oai_settings.custom_include_body after A→B→A round-trip:', JSON.stringify(liveAfterReturn));

        // These two assertions codify the bug. In the buggy code both will be
        // "" and the test fails, reproducing the user report. In fixed code
        // both must equal CUSTOM_INCLUDE_BODY_A.
        expect(profileAAfterReturn, 'profile A should have kept the saved custom-include-body across the A→B→A switch').toBe(CUSTOM_INCLUDE_BODY_A);
        expect(liveAfterReturn, 'oai_settings.custom_include_body should be restored on switching back to A').toBe(CUSTOM_INCLUDE_BODY_A);
    });
});
