import { test, expect } from '../../harness/playwright.js';
import { observeOperations } from '../../harness/observations.js';
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { appendConnectionProfile, bootstrapCustomBackend, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    closeExtensionsDrawer,
    openExtensionsDrawer,
    openInlineDrawer,
    selectCharacterByName,
    sendMessageAndAwaitReply,
} from '../_lib/page.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';
import { read as readPngCard } from '../../../src/character-card-parser.js';

const AVATAR_A = 'watchpost-regex-a.png';
const AVATAR_B = 'watchpost-regex-b.png';
const NAME_A = 'Keeper of the Watchpost Regex';
const NAME_B = 'Keeper of the Harbor Regex';
const BOUND_PRESET_NAME = 'Watchpost Bound Preset';

const INITIAL_SCOPED_SCRIPT = {
    id: 'scoped-seed-beacon-1',
    scriptName: 'Seed Tide Marker',
    findRegex: '/\\[TIDE\\]/g',
    replaceString: 'HIGH-TIDE',
    trimStrings: ['~'],
    placement: [1],
    disabled: false,
    markdownOnly: false,
    promptOnly: false,
    pluginLanes: [],
    runOnEdit: true,
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null,
};

const SECOND_SCOPED_SCRIPT = {
    id: 'scoped-seed-lantern-2',
    scriptName: 'Seed Lantern Reply',
    findRegex: '/lantern/g',
    replaceString: 'BEACON',
    trimStrings: [],
    placement: [2],
    disabled: false,
    markdownOnly: false,
    promptOnly: false,
    pluginLanes: [],
    runOnEdit: false,
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null,
};

const INITIAL_GLOBAL_SCRIPT = {
    id: 'global-seed-compass-1',
    scriptName: 'Seed Compass Global',
    findRegex: '/compass/g',
    replaceString: 'COMPASS',
    trimStrings: [],
    placement: [1],
    disabled: false,
    markdownOnly: false,
    promptOnly: false,
    pluginLanes: [],
    runOnEdit: false,
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null,
};

const INITIAL_EXT_A = {
    retained: { sibling: 'keep-watchpost', tags: ['reef', 'watch'] },
    regex_scripts: [INITIAL_SCOPED_SCRIPT],
};

const INITIAL_EXT_B = {
    retained: { sibling: 'keep-harbor' },
    regex_scripts: [
        {
            ...SECOND_SCOPED_SCRIPT,
            id: 'scoped-b-only-1',
            scriptName: 'Harbor Fog Rule',
        },
    ],
};

let server;
let mock;

const cardPath = (avatar = AVATAR_A) => resolve(server.dataRoot, 'default-user', 'characters', avatar);
const settingsPath = () => resolve(server.dataRoot, 'default-user', 'settings.json');
const readDiskCard = (avatar = AVATAR_A) => JSON.parse(readPngCard(readFileSync(cardPath(avatar)))).data;
const readDiskSettings = () => JSON.parse(readFileSync(settingsPath(), 'utf8'));

async function openRegexDrawer(page) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'regex_container');
    for (const blockId of ['global_scripts_block', 'preset_scripts_block', 'scoped_scripts_block']) {
        const block = page.locator(`#${blockId}`);
        const content = block.locator(':scope > .inline-drawer-content');
        const visible = await content.evaluate((el) => Boolean(el) && window.getComputedStyle(el).display !== 'none').catch(() => false);
        if (!visible) {
            await block.locator(':scope > .inline-drawer-toggle').first().click();
            await expect(content).toBeVisible();
        }
    }
}

async function readRegexMirrors(page, avatarA = AVATAR_A, avatarB = AVATAR_B) {
    return page.evaluate(({ a, b }) => {
        const ctx = window.Luker.getContext();
        const charA = ctx.characters.find(c => c?.avatar === a);
        const charB = ctx.characters.find(c => c?.avatar === b);
        const selected = ctx.characters[Number(ctx.characterId)];
        const editorJsonRaw = document.querySelector('#character_json_data')?.value || '';
        const editorJson = editorJsonRaw ? JSON.parse(editorJsonRaw) : null;
        return {
            selectedAvatar: selected?.avatar || null,
            liveA: charA?.data?.extensions ?? null,
            jsonA: charA?.json_data ? JSON.parse(charA.json_data).data.extensions : null,
            liveB: charB?.data?.extensions ?? null,
            jsonB: charB?.json_data ? JSON.parse(charB.json_data).data.extensions : null,
            editorExtensions: editorJson?.data?.extensions ?? null,
            globalScripts: ctx.extensionSettings?.regex ?? [],
            allowedScopedAvatars: ctx.extensionSettings?.character_allowed_regex ?? [],
            scopedRowIds: Array.from(document.querySelectorAll('#saved_scoped_scripts .regex-script-label')).map(el => el.getAttribute('id')),
            scopedRowNames: Array.from(document.querySelectorAll('#saved_scoped_scripts .regex-script-label .regex_script_name')).map(el => el.textContent),
            globalRowIds: Array.from(document.querySelectorAll('#saved_regex_scripts .regex-script-label')).map(el => el.getAttribute('id')),
        };
    }, { a: avatarA, b: avatarB });
}

async function fillRegexEditor(popup, {
    scriptName,
    findRegex,
    replaceString,
    trimStrings = '',
    placements = [1],
    markdownOnly = false,
    promptOnly = false,
    runOnEdit = false,
    disabled = false,
}) {
    await popup.locator('input.regex_script_name').fill(scriptName);
    await popup.locator('input.find_regex').fill(findRegex);
    await popup.locator('textarea.regex_replace_string').fill(replaceString);
    await popup.locator('textarea.regex_trim_strings').fill(trimStrings);
    const allPlacements = popup.locator('input[name="replace_position"]');
    const count = await allPlacements.count();
    for (let i = 0; i < count; i++) {
        const cb = allPlacements.nth(i);
        if (await cb.isChecked()) await cb.uncheck();
    }
    for (const val of placements) {
        await popup.locator(`input[name="replace_position"][value="${val}"]`).check();
    }
    const setBox = async (selector, want) => {
        const cb = popup.locator(selector);
        const checked = await cb.isChecked();
        if (want && !checked) await cb.check();
        else if (!want && checked) await cb.uncheck();
    };
    await setBox('input[name="only_format_display"]', markdownOnly);
    await setBox('input[name="only_format_prompt"]', promptOnly);
    await setBox('input[name="run_on_edit"]', runOnEdit);
    await setBox('input[name="disabled"]', disabled);
}

async function bootstrapScenario(resources, {
    scenarioId,
    extA = INITIAL_EXT_A,
    extB = INITIAL_EXT_B,
    globalScripts = [INITIAL_GLOBAL_SCRIPT],
    allowedScopedAvatars = [AVATAR_A],
    scriptedReplies = ['*Ash trims the lantern wick along the headland.* "The lantern burns clear tonight."'],
} = {}) {
    mock = await startMockLLM({ scriptedReplies });
    server = await startServer({
        scope: resources,
        batchKey: 'extensions',
        scenarioId,
        extraConfig: { storage: { mode: 'fs' } },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    const settings = readDiskSettings();
    settings.extension_settings = settings.extension_settings || {};
    settings.extension_settings.regex = structuredClone(globalScripts);
    settings.extension_settings.character_allowed_regex = [...allowedScopedAvatars];
    writeFileSync(settingsPath(), JSON.stringify(settings, null, 4));

    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: AVATAR_A,
        overrides: { name: NAME_A, extensions: structuredClone(extA) },
    });
    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: AVATAR_B,
        overrides: { name: NAME_B, extensions: structuredClone(extB) },
    });
}

test.afterEach(async () => {
    await mock?.stop();
    mock = null;
});

for (const failureMode of ['http', 'transport']) {
    test(`scoped editor create and edit keep input open on ${failureMode} failure, then retry and apply pre/post transforms`, async ({ page, context, resources }) => {
        test.setTimeout(120_000);
        await bootstrapScenario(resources, {
            scenarioId: `104-regex-editor-${failureMode}`,
            allowedScopedAvatars: [AVATAR_B],
        });
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, NAME_B);
        await selectCharacterByName(page, NAME_A);
        // Dismiss embedded regex alert that opens for unallowed character A.
        const embeddedConfirm = page.locator('dialog.popup[open]').last();
        await expect(embeddedConfirm).toBeVisible();
        await embeddedConfirm.locator('.popup-button-cancel').click();
        await expect(embeddedConfirm).toBeHidden();
        await openRegexDrawer(page);

        // Open "+ Scoped" editor and enter a new AI_OUTPUT rule.
        await page.locator('#open_scoped_editor').click();
        const popup = page.locator('dialog.popup[open]').last();
        await expect(popup).toBeVisible();
        await fillRegexEditor(popup, {
            scriptName: 'Headland Lantern Transform',
            findRegex: '/lantern/g',
            replaceString: 'SIGNAL-FLAME',
            placements: [2],
            markdownOnly: false,
            promptOnly: false,
            runOnEdit: true,
        });

        const originalBytes = readFileSync(cardPath(AVATAR_A));
        const held = cardPath(AVATAR_A) + '.held';
        if (failureMode === 'http') renameSync(cardPath(AVATAR_A), held);
        else await context.setOffline(true);

        try {
            const waitOutcome = failureMode === 'http'
                ? page.waitForResponse(r => r.url().endsWith('/api/characters/merge-attributes'))
                : page.waitForEvent('requestfailed', r => r.url().endsWith('/api/characters/merge-attributes'));
            await popup.locator('.popup-button-ok').first().click();
            const outcome = await waitOutcome;
            if (failureMode === 'http') expect(outcome.status()).toBe(500);

            // Popup MUST stay open with editable user inputs preserved.
            await expect(popup).toBeVisible();
            await expect(popup.locator('input.regex_script_name')).toHaveValue('Headland Lantern Transform');
            await expect(popup.locator('input.find_regex')).toHaveValue('/lantern/g');
            await expect(popup.locator('textarea.regex_replace_string')).toHaveValue('SIGNAL-FLAME');
            await expect(page.locator('#toast-container .toast-error').filter({ hasText: 'Could not save character-scoped regex script.' }).first()).toBeVisible();

            // Complete card/live/json/editor/other-character state remains untouched; character not allowed yet.
            const mirrors = await readRegexMirrors(page);
            expect(mirrors.liveA).toEqual(INITIAL_EXT_A);
            expect(mirrors.jsonA).toEqual(INITIAL_EXT_A);
            expect(mirrors.editorExtensions).toEqual(INITIAL_EXT_A);
            expect(mirrors.liveB).toEqual(INITIAL_EXT_B);
            expect(mirrors.allowedScopedAvatars).toEqual([AVATAR_B]);
            expect(mirrors.scopedRowIds).toEqual([INITIAL_SCOPED_SCRIPT.id]);
            expect(readFileSync(failureMode === 'http' ? held : cardPath(AVATAR_A))).toEqual(originalBytes);
        } finally {
            if (failureMode === 'http') renameSync(held, cardPath(AVATAR_A));
            else await context.setOffline(false);
        }

        // Retry directly from the still-open editor popup.
        const retryResponse = page.waitForResponse(r => r.url().endsWith('/api/characters/merge-attributes') && r.status() === 200);
        await popup.locator('.popup-button-ok').first().click();
        await retryResponse;
        await expect(popup).toBeHidden();

        const afterCreate = await readRegexMirrors(page);
        expect(afterCreate.liveA.regex_scripts).toHaveLength(2);
        const created = afterCreate.liveA.regex_scripts[1];
        const expectedCreated = {
            id: created.id,
            scriptName: 'Headland Lantern Transform',
            findRegex: '/lantern/g',
            replaceString: 'SIGNAL-FLAME',
            trimStrings: [],
            placement: [2],
            disabled: false,
            markdownOnly: false,
            promptOnly: false,
            pluginLanes: [],
            runOnEdit: true,
            substituteRegex: 0,
            minDepth: null,
            maxDepth: null,
        };
        const expectedExtAfterCreate = {
            ...INITIAL_EXT_A,
            regex_scripts: [INITIAL_SCOPED_SCRIPT, expectedCreated],
        };
        expect(readDiskCard(AVATAR_A).extensions).toEqual(expectedExtAfterCreate);
        expect(afterCreate.liveA).toEqual(expectedExtAfterCreate);
        expect(afterCreate.jsonA).toEqual(expectedExtAfterCreate);
        expect(afterCreate.editorExtensions).toEqual(expectedExtAfterCreate);
        expect(readDiskCard(AVATAR_B).extensions).toEqual(INITIAL_EXT_B);
        expect(afterCreate.allowedScopedAvatars).toContain(AVATAR_A);

        // Edit the existing seed script, fail once, keep edits open, then retry preserving ID & order.
        await page.locator(`#saved_scoped_scripts #${INITIAL_SCOPED_SCRIPT.id} .edit_existing_regex`).click();
        const editPopup = page.locator('dialog.popup[open]').last();
        await expect(editPopup).toBeVisible();
        await editPopup.locator('input.regex_script_name').fill('Revised Tide Marker');
        await editPopup.locator('textarea.regex_replace_string').fill('SPRING-TIDE');

        if (failureMode === 'http') renameSync(cardPath(AVATAR_A), held);
        else await context.setOffline(true);
        try {
            const failWait = failureMode === 'http'
                ? page.waitForResponse(r => r.url().endsWith('/api/characters/merge-attributes'))
                : page.waitForEvent('requestfailed', r => r.url().endsWith('/api/characters/merge-attributes'));
            await editPopup.locator('.popup-button-ok').first().click();
            await failWait;
            await expect(editPopup).toBeVisible();
            await expect(editPopup.locator('input.regex_script_name')).toHaveValue('Revised Tide Marker');
            expect((await readRegexMirrors(page)).liveA).toEqual(expectedExtAfterCreate);
        } finally {
            if (failureMode === 'http') renameSync(held, cardPath(AVATAR_A));
            else await context.setOffline(false);
        }

        const editOk = page.waitForResponse(r => r.url().endsWith('/api/characters/merge-attributes') && r.status() === 200);
        await editPopup.locator('.popup-button-ok').first().click();
        await editOk;
        await expect(editPopup).toBeHidden();

        const expectedEditedSeed = {
            ...INITIAL_SCOPED_SCRIPT,
            scriptName: 'Revised Tide Marker',
            replaceString: 'SPRING-TIDE',
        };
        const expectedExtAfterEdit = {
            ...INITIAL_EXT_A,
            regex_scripts: [expectedEditedSeed, expectedCreated],
        };
        const afterEdit = await readRegexMirrors(page);
        expect(readDiskCard(AVATAR_A).extensions).toEqual(expectedExtAfterEdit);
        expect(afterEdit.liveA).toEqual(expectedExtAfterEdit);
        expect(afterEdit.jsonA).toEqual(expectedExtAfterEdit);
        expect(afterEdit.editorExtensions).toEqual(expectedExtAfterEdit);

        // Verify real pre-process (USER_INPUT) and post-process (AI_OUTPUT) regex execution on a real turn.
        await closeExtensionsDrawer(page);
        const beforeCount = mock.requests.length;
        const { text: replyText } = await sendMessageAndAwaitReply(page, 'Checking reef markers at [TIDE] before dusk.');
        const chatReq = mock.requests.slice(beforeCount).find(r => r.url.includes('chat/completions'));
        expect(chatReq).toBeTruthy();
        const sentMessages = JSON.stringify(chatReq.body.messages);
        expect(sentMessages).toContain('SPRING-TIDE');
        expect(sentMessages).not.toContain('[TIDE]');
        expect(replyText).toContain('SIGNAL-FLAME');
        expect(replyText).not.toMatch(/\blantern\b/);
    });
}

test('scoped row toggle, bulk toggle, delete, and import preserve state on failure and recover on retry', async ({ page, resources }) => {
    test.setTimeout(120_000);
    const seedTwo = {
        ...INITIAL_EXT_A,
        regex_scripts: [INITIAL_SCOPED_SCRIPT, SECOND_SCOPED_SCRIPT],
    };
    await bootstrapScenario(resources, {
        scenarioId: '104-regex-controls',
        extA: seedTwo,
    });
    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, NAME_A);
    await openRegexDrawer(page);

    const held = cardPath(AVATAR_A) + '.held';

    // 1. Row toggle failure must NOT mutate live script record or keep checkbox flipped.
    renameSync(cardPath(AVATAR_A), held);
    try {
        const failToggle = page.waitForResponse(r => r.url().endsWith('/api/characters/merge-attributes'));
        await page.locator(`#saved_scoped_scripts #${INITIAL_SCOPED_SCRIPT.id} .regex-toggle-on`).click();
        expect((await failToggle).status()).toBe(500);
        await expect(page.locator('#toast-container .toast-error').last()).toBeVisible();
        const afterFailToggle = await readRegexMirrors(page);
        expect(afterFailToggle.liveA).toEqual(seedTwo);
        expect(afterFailToggle.jsonA).toEqual(seedTwo);
        await expect(page.locator(`#saved_scoped_scripts #${INITIAL_SCOPED_SCRIPT.id} .disable_regex`)).not.toBeChecked();
    } finally {
        renameSync(held, cardPath(AVATAR_A));
    }

    // 2. Bulk toggle failure must NOT mutate live script objects in place.
    await page.locator('label[for="regex_bulk_edit"]').click();
    await page.locator(`#saved_scoped_scripts #${INITIAL_SCOPED_SCRIPT.id} .regex_bulk_checkbox`).check();
    await page.locator(`#saved_scoped_scripts #${SECOND_SCOPED_SCRIPT.id} .regex_bulk_checkbox`).check();
    renameSync(cardPath(AVATAR_A), held);
    try {
        const failBulk = page.waitForResponse(r => r.url().endsWith('/api/characters/merge-attributes'));
        await page.locator('#bulk_disable_regex').click();
        expect((await failBulk).status()).toBe(500);
        const afterFailBulk = await readRegexMirrors(page);
        expect(afterFailBulk.liveA).toEqual(seedTwo);
        expect(afterFailBulk.jsonA).toEqual(seedTwo);
    } finally {
        renameSync(held, cardPath(AVATAR_A));
    }

    // Retry bulk disable -> succeeds cleanly.
    const okBulk = page.waitForResponse(r => r.url().endsWith('/api/characters/merge-attributes') && r.status() === 200);
    await page.locator('#bulk_disable_regex').click();
    await okBulk;
    const expectedDisabled = {
        ...INITIAL_EXT_A,
        regex_scripts: [
            { ...INITIAL_SCOPED_SCRIPT, disabled: true },
            { ...SECOND_SCOPED_SCRIPT, disabled: true },
        ],
    };
    await expect.poll(async () => (await readRegexMirrors(page)).liveA).toEqual(expectedDisabled);
    expect(readDiskCard(AVATAR_A).extensions).toEqual(expectedDisabled);

    // 3. Delete failure must retain complete script in disk/live/json/UI.
    renameSync(cardPath(AVATAR_A), held);
    try {
        await page.locator(`#saved_scoped_scripts #${SECOND_SCOPED_SCRIPT.id} .delete_regex`).click();
        const confirmDel = page.locator('dialog.popup[open]').last();
        const failDel = page.waitForResponse(r => r.url().endsWith('/api/characters/merge-attributes'));
        await confirmDel.locator('.popup-button-ok').click();
        expect((await failDel).status()).toBe(500);
        await expect.poll(async () => (await readRegexMirrors(page)).scopedRowIds).toEqual([INITIAL_SCOPED_SCRIPT.id, SECOND_SCOPED_SCRIPT.id]);
        expect((await readRegexMirrors(page)).liveA).toEqual(expectedDisabled);
    } finally {
        renameSync(held, cardPath(AVATAR_A));
    }

    // Retry delete -> removes cleanly.
    await page.locator(`#saved_scoped_scripts #${SECOND_SCOPED_SCRIPT.id} .delete_regex`).click();
    const confirmDelRetry = page.locator('dialog.popup[open]').last();
    const okDel = page.waitForResponse(r => r.url().endsWith('/api/characters/merge-attributes') && r.status() === 200);
    await confirmDelRetry.locator('.popup-button-ok').click();
    await okDel;
    const expectedAfterDelete = {
        ...INITIAL_EXT_A,
        regex_scripts: [{ ...INITIAL_SCOPED_SCRIPT, disabled: true }],
    };
    await expect.poll(async () => (await readRegexMirrors(page)).liveA).toEqual(expectedAfterDelete);
    expect(readDiskCard(AVATAR_A).extensions).toEqual(expectedAfterDelete);

    // 4. Import valid regex JSON into Scoped when storage fails must NOT report "Invalid regex object" or mutate live scripts.
    const importDir = await resources.directory('regex-import-fixture');
    const importFile = resolve(importDir.path, 'reef-rule.json');
    const importedRule = {
        scriptName: 'Imported Reef Rule',
        findRegex: '/reef/g',
        replaceString: 'SHOAL',
        trimStrings: [],
        placement: [1],
        disabled: false,
        markdownOnly: false,
        promptOnly: false,
        pluginLanes: [],
        runOnEdit: false,
        substituteRegex: 0,
        minDepth: null,
        maxDepth: null,
    };
    writeFileSync(importFile, JSON.stringify(importedRule, null, 2));

    renameSync(cardPath(AVATAR_A), held);
    try {
        await page.locator('#import_regex_file').setInputFiles(importFile);
        const targetPopup = page.locator('dialog.popup[open]').last();
        await expect(targetPopup).toBeVisible();
        await targetPopup.locator('#regex_import_target_scoped').check();
        const failImport = page.waitForResponse(r => r.url().endsWith('/api/characters/merge-attributes'));
        await targetPopup.locator('.popup-button-ok').click();
        expect((await failImport).status()).toBe(500);
        await expect(page.locator('#toast-container')).not.toContainText('Invalid regex object.');
        await expect(page.locator('#toast-container .toast-success')).toHaveCount(0);
        await expect.poll(async () => (await readRegexMirrors(page)).liveA).toEqual(expectedAfterDelete);
    } finally {
        renameSync(held, cardPath(AVATAR_A));
    }

    // Retry import -> succeeds cleanly.
    await page.locator('#import_regex_file').setInputFiles(importFile);
    const targetPopupRetry = page.locator('dialog.popup[open]').last();
    await expect(targetPopupRetry).toBeVisible();
    await targetPopupRetry.locator('#regex_import_target_scoped').check();
    const okImport = page.waitForResponse(r => r.url().endsWith('/api/characters/merge-attributes') && r.status() === 200);
    await targetPopupRetry.locator('.popup-button-ok').click();
    await okImport;
    await expect.poll(async () => (await readRegexMirrors(page)).liveA.regex_scripts.length).toBe(2);
    const afterImport = await readRegexMirrors(page);
    expect(afterImport.liveA.regex_scripts[1]).toMatchObject({ ...importedRule, id: afterImport.liveA.regex_scripts[1].id });
    expect(readDiskCard(AVATAR_A).extensions).toEqual(afterImport.liveA);
});

test('cross-store moves never delete source before acknowledged destination and report partial success honestly', async ({ page, context, resources }) => {
    test.setTimeout(120_000);
    await bootstrapScenario(resources, { scenarioId: '104-regex-moves' });
    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, NAME_A);
    await openRegexDrawer(page);

    const held = cardPath(AVATAR_A) + '.held';

    // 1. Move Global -> Scoped when card write fails: source Global script MUST be retained untouched.
    renameSync(cardPath(AVATAR_A), held);
    try {
        await page.locator(`#saved_regex_scripts #${INITIAL_GLOBAL_SCRIPT.id} .regex_script_expand`).click();
        await page.locator(`#saved_regex_scripts #${INITIAL_GLOBAL_SCRIPT.id} .move_to_scoped`).click();
        const confirmMove = page.locator('dialog.popup[open]').last();
        const failDest = page.waitForResponse(r => r.url().endsWith('/api/characters/merge-attributes'));
        await confirmMove.locator('.popup-button-ok').click();
        expect((await failDest).status()).toBe(500);
        await expect(page.locator('#toast-container .toast-error').last()).toBeVisible();
        const afterFailedToScoped = await readRegexMirrors(page);
        expect(afterFailedToScoped.globalScripts).toEqual([INITIAL_GLOBAL_SCRIPT]);
        expect(afterFailedToScoped.liveA).toEqual(INITIAL_EXT_A);
        expect(afterFailedToScoped.globalRowIds).toEqual([INITIAL_GLOBAL_SCRIPT.id]);
    } finally {
        renameSync(held, cardPath(AVATAR_A));
    }

    // 2. Move Scoped -> Global when settings persistence fails (offline): scheduled global debounce is NOT enough, source Scoped MUST remain!
    await context.setOffline(true);
    try {
        const beforeToastCount = await page.locator('#toast-container .toast-error').count();
        await page.locator(`#saved_scoped_scripts #${INITIAL_SCOPED_SCRIPT.id} .regex_script_expand`).click();
        await page.locator(`#saved_scoped_scripts #${INITIAL_SCOPED_SCRIPT.id} .move_to_global`).click();
        const confirmMoveGlobal = page.locator('dialog.popup[open]').last();
        const failedSettings = page.waitForEvent('requestfailed', r => /\/api\/settings\/(save|patch)$/.test(r.url()));
        await confirmMoveGlobal.locator('.popup-button-ok').click();
        await failedSettings;
        await expect.poll(async () => page.locator('#toast-container .toast-error').count()).toBeGreaterThan(beforeToastCount);
        await expect.poll(async () => (await readRegexMirrors(page)).globalScripts).toEqual([INITIAL_GLOBAL_SCRIPT]);
        const afterFailedToGlobal = await readRegexMirrors(page);
        expect(afterFailedToGlobal.liveA).toEqual(INITIAL_EXT_A);
        expect(readDiskCard(AVATAR_A).extensions).toEqual(INITIAL_EXT_A);
        expect(afterFailedToGlobal.globalScripts).toEqual([INITIAL_GLOBAL_SCRIPT]);
    } finally {
        await context.setOffline(false);
    }

    // 3. Move Scoped -> Global when Global settings save ACKNOWLEDGES, then Scoped source delete FAILS (HTTP 500):
    //    truthful partial outcome — destination keeps the script, source keeps its copy, error toast reports partial move!
    renameSync(cardPath(AVATAR_A), held);
    try {
        await page.locator(`#saved_scoped_scripts #${INITIAL_SCOPED_SCRIPT.id} .regex_script_expand`).click();
        await page.locator(`#saved_scoped_scripts #${INITIAL_SCOPED_SCRIPT.id} .move_to_global`).click();
        const confirmPartial = page.locator('dialog.popup[open]').last();
        const settingsOk = page.waitForResponse(r => /\/api\/settings\/(save|patch)$/.test(r.url()) && r.status() === 200);
        const cardDeleteFail = page.waitForResponse(r => r.url().endsWith('/api/characters/merge-attributes') && r.status() === 500);
        await confirmPartial.locator('.popup-button-ok').click();
        await settingsOk;
        await cardDeleteFail;
        await expect(page.locator('#toast-container .toast-error').last()).toBeVisible();
        const afterPartial = await readRegexMirrors(page);
        expect(afterPartial.globalScripts.map(s => s.id)).toEqual([INITIAL_GLOBAL_SCRIPT.id, INITIAL_SCOPED_SCRIPT.id]);
        expect(readDiskSettings().extension_settings.regex.map(s => s.id)).toEqual([INITIAL_GLOBAL_SCRIPT.id, INITIAL_SCOPED_SCRIPT.id]);
        expect(afterPartial.liveA).toEqual(INITIAL_EXT_A);
        expect(afterPartial.scopedRowIds).toEqual([INITIAL_SCOPED_SCRIPT.id]);
    } finally {
        renameSync(held, cardPath(AVATAR_A));
    }
});

test('persisted invalid-entry cleanup fails honestly and racing a real edit preserves the newly saved sibling', async ({ page, resources }) => {
    test.setTimeout(120_000);
    const corruptExt = {
        ...INITIAL_EXT_A,
        regex_scripts: [INITIAL_SCOPED_SCRIPT, null],
    };
    await bootstrapScenario(resources, {
        scenarioId: '104-regex-cleanup-race',
        extA: corruptExt,
    });

    // Subcase A: Cleanup failure keeps persisted/live invalid entry intact and does NOT falsely claim automatic removal.
    const charsDir = resolve(server.dataRoot, 'default-user', 'characters');
    await awaitMainUI(page, server.baseURL);
    chmodSync(charsDir, 0o555);
    try {
        const failedCleanup = page.waitForResponse(r => r.url().endsWith('/api/characters/merge-attributes'));
        await selectCharacterByName(page, NAME_A);
        expect((await failedCleanup).status()).toBe(500);
        await expect(page.locator('#toast-container .toast-error')).toBeVisible();
        await expect(page.locator('#toast-container .toast-error')).not.toContainText('were removed automatically');
        const mirrorsWhileOffline = await readRegexMirrors(page);
        expect(mirrorsWhileOffline.liveA.regex_scripts).toEqual([INITIAL_SCOPED_SCRIPT, null]);
    } finally {
        chmodSync(charsDir, 0o755);
    }

    // Subcase B: Reload with corrupt card, hold cleanup's merge-attributes response via observeOperations,
    // save a real new sibling script via UI editor while cleanup is in flight -> BOTH survive and null is removed!
    const observer = await observeOperations({
        page,
        scope: resources,
        baseURL: server.baseURL,
        patterns: ['Request', 'Response'].map(requestStage => ({ urlPattern: '*/api/characters/merge-attributes*', requestStage })),
        networkFilter: e => new URL(e.request.url).pathname.endsWith('/api/characters/merge-attributes'),
        readStored: () => readDiskCard(AVATAR_A),
        recordBodies: true,
        enableDebugger: false,
    });
    const heldResponses = [];
    let releaseFirstResolver = null;
    observer.hold('hold-first-cleanup-response', ({ response, event }) => {
        if (!response) return false;
        if (heldResponses.length === 0) {
            heldResponses.push(event);
            releaseFirstResolver?.(event);
            return true;
        }
        return false;
    }, { repeat: false });

    try {
        const firstHeldPromise = new Promise(r => { releaseFirstResolver = r; });
        await page.reload();
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, NAME_A);
        const firstCleanupEvent = await firstHeldPromise;

        // While cleanup POST is still held, open the real "+ Scoped" editor and save a new sibling script.
        await openRegexDrawer(page);
        await page.locator('#open_scoped_editor').click();
        const popup = page.locator('dialog.popup[open]').last();
        await expect(popup).toBeVisible();
        await fillRegexEditor(popup, {
            scriptName: 'Sibling Saved During Cleanup',
            findRegex: '/harbor/g',
            replaceString: 'ANCHORAGE',
            placements: [1],
        });
        await popup.locator('.popup-button-ok').first().click();

        // Release the held cleanup response; the queued real edit executes next and must survive intact.
        await observer.release(firstCleanupEvent);
        await expect(popup).toBeHidden();

        const finalMirrors = await readRegexMirrors(page);
        expect(finalMirrors.liveA.regex_scripts.map(s => s.scriptName)).toEqual([
            INITIAL_SCOPED_SCRIPT.scriptName,
            'Sibling Saved During Cleanup',
        ]);
        expect(readDiskCard(AVATAR_A).extensions.regex_scripts.map(s => s.scriptName)).toEqual([
            INITIAL_SCOPED_SCRIPT.scriptName,
            'Sibling Saved During Cleanup',
        ]);
        expect(finalMirrors.jsonA).toEqual(finalMirrors.liveA);
        expect(finalMirrors.editorExtensions).toEqual(finalMirrors.liveA);
    } finally {
        await observer.close();
    }
});

test('selected character change during pending scoped write keeps ownership on original character and preset failure keeps editor open', async ({ page, resources }) => {
    test.setTimeout(120_000);
    const defaultPreset = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../default/content/presets/openai/Default.json'), 'utf8'));
    const boundExtA = {
        ...INITIAL_EXT_A,
        luker: {
            chat_completion_preset: {
                presets: [
                    { name: BOUND_PRESET_NAME, preset: { ...defaultPreset, temperature: 0.35, extensions: { retained: 'bound-preset-sibling' } } },
                ],
                defaultPresetName: BOUND_PRESET_NAME,
            },
        },
    };
    await bootstrapScenario(resources, {
        scenarioId: '104-regex-ownership-and-preset',
        extA: boundExtA,
        allowedScopedAvatars: [AVATAR_B],
    });

    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, NAME_B);
    await selectCharacterByName(page, NAME_A);
    const embeddedConfirm = page.locator('dialog.popup[open]').last();
    await expect(embeddedConfirm).toBeVisible();
    await embeddedConfirm.locator('.popup-button-cancel').click();
    await expect(embeddedConfirm).toBeHidden();
    await openRegexDrawer(page);
    const baselineExtA = readDiskCard(AVATAR_A).extensions;

    // Part 1: Hold Character A's scoped save response, switch selection to Character B while pending, release A's save.
    const observer = await observeOperations({
        page,
        scope: resources,
        baseURL: server.baseURL,
        patterns: ['Request', 'Response'].map(requestStage => ({ urlPattern: '*/api/characters/merge-attributes*', requestStage })),
        networkFilter: e => new URL(e.request.url).pathname.endsWith('/api/characters/merge-attributes'),
        readStored: () => ({ a: readDiskCard(AVATAR_A), b: readDiskCard(AVATAR_B) }),
        recordBodies: true,
        enableDebugger: false,
    });
    let heldSaveEvent = null;
    let heldReady = null;
    const heldPromise = new Promise(r => { heldReady = r; });
    observer.hold('hold-scoped-save-a', ({ response, event }) => {
        if (!response) return false;
        heldSaveEvent = event;
        heldReady(event);
        return true;
    }, { repeat: false });

    try {
        await page.locator(`#saved_scoped_scripts #${INITIAL_SCOPED_SCRIPT.id} .regex-toggle-on`).click();
        await heldPromise;

        // Switch selected character to Character B via real UI while Character A's scoped write is in flight.
        await selectCharacterByName(page, NAME_B);
        await expect.poll(async () => (await readRegexMirrors(page)).selectedAvatar).toBe(AVATAR_B);

        // Release Character A's 200 response.
        await observer.release(heldSaveEvent);

        // Ownership assertions: A has the toggled script & A's avatar is allowed; B is 100% untouched!
        await expect.poll(async () => (await readRegexMirrors(page)).liveA.regex_scripts[0].disabled).toBe(true);
        const mirrors = await readRegexMirrors(page);
        const diskA = readDiskCard(AVATAR_A).extensions;
        expect(mirrors.selectedAvatar).toBe(AVATAR_B);
        expect(mirrors.liveA.regex_scripts).toEqual([{ ...INITIAL_SCOPED_SCRIPT, disabled: true }]);
        expect(mirrors.liveA.retained).toEqual(baselineExtA.retained);
        expect(diskA).toEqual(mirrors.liveA);
        expect(mirrors.jsonA).toEqual(mirrors.liveA);
        expect(mirrors.liveB).toEqual(INITIAL_EXT_B);
        expect(readDiskCard(AVATAR_B).extensions).toEqual(INITIAL_EXT_B);
        expect(mirrors.editorExtensions).toEqual(INITIAL_EXT_B);
        expect(mirrors.allowedScopedAvatars).toEqual([AVATAR_B, AVATAR_A]);
        expect(mirrors.scopedRowIds).toEqual(INITIAL_EXT_B.regex_scripts.map(s => s.id));
    } finally {
        await observer.close();
    }

    // Part 2: Switch back to Character A (bound preset active), make characters dir read-only so settings save succeeds
    // while card-bound preset write fails -> Preset Regex Editor MUST remain open with editable input & retry cleanly!
    await selectCharacterByName(page, NAME_A);
    await openRegexDrawer(page);
    await page.locator('#open_preset_editor').click();
    const presetPopup = page.locator('dialog.popup[open]').last();
    await expect(presetPopup).toBeVisible();
    await fillRegexEditor(presetPopup, {
        scriptName: 'Bound Preset Failure Rule',
        findRegex: '/dusk/g',
        replaceString: 'TWILIGHT',
        placements: [1],
    });

    const charsDir = resolve(server.dataRoot, 'default-user', 'characters');
    chmodSync(charsDir, 0o555);
    try {
        const failCardStage = page.waitForResponse(r => r.url().endsWith('/api/characters/merge-attributes'));
        await presetPopup.locator('.popup-button-ok').first().click();
        expect((await failCardStage).status()).toBe(500);

        // Editor MUST stay open with editable user input intact and an error toast surfaced.
        await expect(presetPopup).toBeVisible();
        await expect(presetPopup.locator('input.regex_script_name')).toHaveValue('Bound Preset Failure Rule');
        await expect(presetPopup.locator('input.find_regex')).toHaveValue('/dusk/g');
        await expect(presetPopup.locator('textarea.regex_replace_string')).toHaveValue('TWILIGHT');
        await expect(page.locator('#toast-container .toast-error').last()).toBeVisible();
        // Card bound preset slot on disk was NOT mutated.
        const diskSlot = readDiskCard(AVATAR_A).extensions.luker.chat_completion_preset.presets[0].preset;
        expect(diskSlot.extensions.regex_scripts).toBeUndefined();
    } finally {
        chmodSync(charsDir, 0o755);
    }

    // Retry from the still-open preset regex editor -> succeeds and closes!
    const okCardStage = page.waitForResponse(r => r.url().endsWith('/api/characters/merge-attributes') && r.status() === 200);
    await presetPopup.locator('.popup-button-ok').first().click();
    await okCardStage;
    await expect(presetPopup).toBeHidden();
    const savedSlot = readDiskCard(AVATAR_A).extensions.luker.chat_completion_preset.presets[0].preset;
    expect(savedSlot.extensions.regex_scripts).toHaveLength(1);
    expect(savedSlot.extensions.regex_scripts[0]).toMatchObject({
        scriptName: 'Bound Preset Failure Rule',
        findRegex: '/dusk/g',
        replaceString: 'TWILIGHT',
        placement: [1],
    });
    expect(savedSlot.extensions.retained).toBe('bound-preset-sibling');
});
