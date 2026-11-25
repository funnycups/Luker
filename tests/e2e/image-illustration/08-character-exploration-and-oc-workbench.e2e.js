// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { awaitMainUI, closeAnyOpenTopSettingsDrawer, fillTopmostPopupAndAccept, openExtensionsDrawer, openInlineDrawer } from '../_lib/page.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { selectWorkbenchTab } from '../_lib/ui-workbench.js';
import { importWorldDocument } from '../_lib/ui-worldinfo.js';
import { openCharacterList } from '../_lib/ui-character.js';

let server;
let llm;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    llm = await startMockLLM();
    server = await startServer({
        scope,
        batchKey: 'image-illustration',
        scenarioId: 'character-source-scope',
        extraConfig: { enableUserAccounts: false },
    });
});

test.afterAll(async () => {
    await llm?.stop();
});

async function uiText(page, text) {
    return page.evaluate(value => window.Luker.getContext().translate(value), text);
}

async function readProfiles(page) {
    const response = await page.request.get(`${server.baseURL}/api/state/get?account=default-user&namespace=sd_character_profiles`);
    if (!response.ok()) {
        throw new Error(`Read character profiles: HTTP ${response.status()} ${await response.text()}`);
    }
    const body = await response.json();
    expect(body.ok).toBe(true);
    return body.data?.profiles ?? {};
}

async function openArchive(page) {
    const workbench = await selectWorkbenchTab(page, 'sd');
    await workbench.locator('[data-sd-nav="characters"]').click();
    await expect(workbench.locator('[data-sd-role="new-profile"]').first()).toBeVisible();
    await expect(workbench.locator('.sdlens-launcher')).toHaveCount(0);
    await expect(workbench.locator('[data-sd-role="refine-in-studio"]')).toHaveCount(0);
    return workbench.locator('[data-sd-view="characters"]');
}

async function openBuilderDialog(page) {
    const archive = await openArchive(page);
    await archive.locator('[data-sd-role="open-ai-builder"]').first().click();
    const dialog = page.locator('[data-sd-role="character-builder-dialog"]').last();
    await expect(dialog).toBeVisible();
    return dialog;
}

function readSdSettings() {
    return JSON.parse(readFileSync(join(server.dataRoot, 'default-user/settings.json'), 'utf8')).extension_settings.sd;
}

async function configureSourceConnection(page, { visualInspection = true, illustrationEnabled = false, characterReferenceEnabled = false } = {}) {
    await page.locator('#API-status-top').click();
    await page.locator('#main_api').selectOption('openai');
    await page.locator('#chat_completion_source').selectOption('custom');
    await page.locator('#custom_api_url_text').fill(llm.baseURL);
    await page.locator('#custom_api_url_text').press('Tab');
    await page.locator('#api_button_openai').click();
    await expect(page.locator('#model_custom_select option[value="mock-gpt-4o"]')).toHaveCount(1);
    await page.locator('#model_custom_select').selectOption('mock-gpt-4o');
    const completionPreset = (await page.locator('#settings_preset_openai option:checked').textContent()).trim();
    const profileName = `Source permission connection ${randomUUID()}`;
    await page.locator('#create_connection_profile').click();
    await fillTopmostPopupAndAccept(page, profileName);
    await expect(page.locator('#connection_profiles option', { hasText: profileName })).toHaveCount(1);
    await page.locator('#API-status-top').click();

    await openExtensionsDrawer(page);
    if (characterReferenceEnabled) {
        await openInlineDrawer(page, 'sd_container');
        await page.locator('#sd_character_reference_enabled').setChecked(true);
        await expect(page.locator('#sd_character_reference_mode')).toBeVisible();
        await page.locator('#sd_character_reference_mode').selectOption('text_only');
    }
    await openInlineDrawer(page, 'sd_illustration_container');
    await page.locator('#sd_illustration_enabled').setChecked(illustrationEnabled);
    await page.locator('#sd_illustration_api_preset').selectOption({ label: profileName });
    await page.locator('#sd_illustration_llm_preset').selectOption({ label: completionPreset });
    const connection = page.locator('#sd_illustration_exploration_api_preset');
    if (!(await connection.isVisible())) {
        await connection.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " inline-drawer ")][1]')
            .locator('> .inline-drawer-toggle').click();
    }
    await connection.selectOption({ label: profileName });
    await page.locator('#sd_illustration_exploration_llm_preset').selectOption({ label: completionPreset });
    await page.locator('#sd_illustration_visual_inspection').setChecked(visualInspection);
    await expect.poll(() => {
        const sd = readSdSettings();
        const settings = sd.illustration;
        return {
            explorationLlm: settings.presets.find(preset => preset.id === settings.currentPresetId).explorationLlm,
            ...(characterReferenceEnabled ? { characterRef: Boolean(sd.character_reference_enabled) } : {}),
        };
    }).toEqual({
        explorationLlm: { apiPresetName: profileName, llmPresetName: completionPreset },
        ...(characterReferenceEnabled ? { characterRef: true } : {}),
    });
    await closeAnyOpenTopSettingsDrawer(page);
}

function builderRequests() {
    return llm.requests.filter(request => request.url.includes('/chat/completions')
        && request.body.tools?.some(tool => tool.function?.name === 'stage_character_profile'));
}

function backgroundExplorationRequests() {
    return llm.requests.filter(request => request.url.includes('/chat/completions')
        && request.body.tools?.some(tool => tool.function?.name === 'save_character_profile'));
}

async function selectMultiOption(page, select, label) {
    await select.locator('xpath=following-sibling::span[contains(@class, "select2")][1]')
        .locator('.select2-selection').click();
    await page.locator('.select2-results__option').filter({ hasText: label }).click();
    await expect(select.locator('option:checked')).toContainText([label]);
}

async function importSourceCard(page, name, primaryBook) {
    await openCharacterList(page);
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#character_import_button').click();
    const imported = page.waitForResponse(response => new URL(response.url()).pathname === '/api/characters/import');
    await (await chooser).setFiles({
        name: `${name}.json`,
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify({
            spec: 'chara_card_v2',
            spec_version: '2.0',
            data: {
                name,
                description: 'A traveler with silver hair and amber eyes.',
                first_mes: 'The traveler unfolds a map on the table.',
                extensions: { world: primaryBook },
            },
        })),
    });
    expect((await imported).ok()).toBeTruthy();
    await page.locator('#rm_print_characters_block .character_select').filter({ hasText: name }).click();
    await expect(page.locator('#character_name_pole')).toHaveValue(name);
    return page.evaluate(value => window.Luker.getContext().characters.find(card => card.name === value).avatar, name);
}

async function setCurrentAuxBook(page, name) {
    await page.locator('#world_button').click({ modifiers: ['Shift'] });
    const popup = page.locator('.popup:visible').last();
    await selectMultiOption(page, popup.locator('.character_extra_world_info_selector'), name);
    await popup.locator('h3').click();
    await popup.locator('.popup-button-ok').click();
}

function toolResults(body, name) {
    const names = new Map();
    const results = [];
    for (const message of body.messages) {
        for (const call of message.tool_calls ?? []) names.set(call.id, call.function.name);
        if (message.role === 'tool' && names.get(message.tool_call_id) === name) {
            results.push(JSON.parse(message.content));
        }
    }
    return results;
}

test('no selected source exposes no card, persona, or world-book tools to the builder dialog agent', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await configureSourceConnection(page);
    llm.scriptCompletion(() => ({ text: 'The supplied source selection has been checked.' }));
    const before = builderRequests().length;
    const dialog = await openBuilderDialog(page);
    await expect(dialog.locator('[data-sd-role="builder-source-select"]')).toHaveValue('none');
    await dialog.locator('[data-sd-role="builder-input"]').fill('Requested character');
    await dialog.locator('[data-sd-role="builder-send"]').click();
    await expect.poll(() => builderRequests().length).toBe(before + 1);
    const names = builderRequests()[before].body.tools.map(tool => tool.function.name);
    expect(names).not.toEqual(expect.arrayContaining(['read_character_card']));
    expect(names).not.toEqual(expect.arrayContaining(['read_user_persona']));
    expect(names).not.toEqual(expect.arrayContaining(['world_book_list']));
    expect(names).not.toEqual(expect.arrayContaining(['lorebook_get']));
    await dialog.locator('[data-sd-role="builder-cancel"]').click();
    await expect(dialog).toBeHidden();
});

test('partial draft updates retain fields the builder agent did not edit', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await configureSourceConnection(page);
    const initialName = `Initial Visual ${randomUUID()}`;
    const revisedName = `Revised Visual ${randomUUID()}`;
    const before = builderRequests().length;
    let round = 0;
    llm.scriptCompletion(() => {
        if (round++ === 0) {
            return {
                tool: 'stage_character_profile',
                arguments: {
                    name: initialName,
                    aliases: ['Wanderer'],
                    source_work: 'Independent setting',
                    description: 'Silver hair. A traveler wearing a blue travel coat.',
                },
            };
        }
        if (round === 2) {
            return {
                tool: 'stage_character_profile',
                arguments: { name: revisedName },
            };
        }
        return { text: 'The draft profile name has been updated.' };
    });

    const dialog = await openBuilderDialog(page);
    await dialog.locator('[data-sd-role="builder-input"]').fill('Stage the visual profile and revise its display name.');
    await dialog.locator('[data-sd-role="builder-send"]').click();
    await expect.poll(() => builderRequests().length).toBe(before + 3);
    await expect(dialog.locator('[data-sd-builder-field="name"]')).toHaveValue(revisedName);
    await dialog.locator('[data-sd-role="builder-confirm"]').click();
    await expect(dialog).toBeHidden();

    const saved = Object.values(await readProfiles(page)).find(p => p.name === revisedName);
    expect(saved).toMatchObject({
        name: revisedName,
        aliases: ['Wanderer'],
        sourceWork: 'Independent setting',
        description: 'Silver hair. A traveler wearing a blue travel coat.',
        referenceImages: [],
    });
});

for (const directory of ['_sandbox_tmp', '_SANDBOX_TMP']) {
    test(`formal background profiles reject ${directory} references until images are promoted`, async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await configureSourceConnection(page, { illustrationEnabled: true, characterReferenceEnabled: true });
        await importSourceCard(page, `Background Card ${randomUUID()}`, '');

        const profileId = `temporary_reference_${randomUUID()}`;
        const temporaryPath = `/user/images/${directory}/${randomUUID()}/draft.png`;
        const beforeExp = backgroundExplorationRequests().length;
        const beforeProfiles = await readProfiles(page);

        let expCalled = false;
        llm.scriptCompletion(({ body }) => {
            const toolNames = (body.tools || []).map(t => t.function?.name);
            if (toolNames.includes('explore_characters')) {
                if (!expCalled) {
                    expCalled = true;
                    return {
                        tool: 'explore_characters',
                        arguments: { targets: [{ name: 'Uncommitted visual draft' }] },
                    };
                }
                return { text: 'No illustration needed.' };
            }
            if (toolNames.includes('save_character_profile')) {
                const alreadyTried = body.messages.some(m => m.role === 'tool');
                if (!alreadyTried) {
                    return {
                        tool: 'save_character_profile',
                        arguments: {
                            id: profileId,
                            name: 'Uncommitted visual draft',
                            reference_images: [{ path: temporaryPath, label: 'Draft' }],
                        },
                    };
                }
                return { text: 'The temporary reference requires promotion before saving.' };
            }
            return { text: 'Done.' };
        });

        await page.locator('#extensionsMenuButton').click();
        await page.locator('#sd_illustration_generate_last').click();
        await expect.poll(() => backgroundExplorationRequests().length, { timeout: 30_000 }).toBe(beforeExp + 2);
        const result = toolResults(backgroundExplorationRequests()[beforeExp + 1].body, 'save_character_profile')[0];
        expect(result).toMatchObject({ ok: false, error: expect.any(String) });
        expect(await readProfiles(page)).toEqual(beforeProfiles);
    });
}

test('a selected source reads only its saved books while another card draft is open', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await configureSourceConnection(page);
    const suffix = randomUUID();
    const primary = `Primary setting ${suffix}`;
    const auxiliary = `Auxiliary setting ${suffix}`;
    const unrelated = `Unselected setting ${suffix}`;
    for (const name of [primary, auxiliary, unrelated]) {
        await importWorldDocument(page, name, {
            entries: {
                0: {
                    uid: 0,
                    key: ['appearance'],
                    comment: 'Visual details',
                    content: `Visual details from ${name}.`,
                    constant: false,
                    disable: false,
                    order: 100,
                },
            },
        });
    }
    const managerSearch = page.locator('#world_info_manager_search');
    if (!(await managerSearch.isVisible())) await page.locator('.world_info_manager_drawer_header').click();
    await managerSearch.fill(unrelated);
    const globalBook = page.locator('.world_info_manager_item').filter({ has: page.getByRole('button', { name: unrelated, exact: true }) });
    await globalBook.locator('.world_info_manager_toggle').click();
    await expect(globalBook).toHaveClass(/is-active/);
    await page.locator('#WIDrawerIcon').click();

    const cardName = `Source character ${suffix}`;
    const avatar = await importSourceCard(page, cardName, primary);
    await setCurrentAuxBook(page, auxiliary);
    await expect.poll(() => {
        const settings = JSON.parse(readFileSync(join(server.dataRoot, 'default-user/settings.json'), 'utf8'));
        return settings.world_info_settings.world_info.charLore?.find(entry => entry.name === avatar.replace(/\.[^.]+$/, ''))?.extraBooks;
    }).toEqual([auxiliary]);

    // Open another uncommitted card draft with unrelated aux book to ensure selected source stays isolated.
    await openCharacterList(page);
    await page.locator('#rm_button_create').click();
    await page.locator('#character_name_pole').fill(`Uncommitted character ${suffix}`);
    await setCurrentAuxBook(page, unrelated);

    const requestsBefore = builderRequests().length;
    const profileName = `Visual identity ${suffix}`;
    let round = 0;
    llm.scriptCompletion(({ body }) => {
        if (round++ === 0) {
            return {
                toolCalls: [
                    { name: 'read_character_card', arguments: {} },
                    { name: 'world_book_list', arguments: {} },
                    { name: 'lorebook_get', arguments: { book_name: unrelated, uids: [0] } },
                ],
            };
        }
        if (round === 2) {
            return {
                toolCalls: [
                    { name: 'lorebook_get', arguments: { book_name: primary, uids: [0] } },
                    { name: 'lorebook_get', arguments: { book_name: auxiliary, uids: [0] } },
                    { name: 'fetch_reference_image', arguments: { image_url: `/characters/${avatar}` } },
                ],
            };
        }
        if (round === 3) {
            const image = toolResults(body, 'fetch_reference_image').at(-1);
            return {
                tool: 'stage_character_profile',
                arguments: {
                    name: profileName,
                    description: 'Silver hair, amber eyes.',
                    reference_images: [{ path: image.imagePath, label: 'Travel outfit' }],
                },
            };
        }
        return { text: 'The requested visual profile is ready.' };
    });

    const dialog = await openBuilderDialog(page);
    await dialog.locator('[data-sd-role="builder-source-select"]').selectOption(`card:${avatar}`);
    await dialog.locator('[data-sd-role="builder-input"]').fill(`Build ${profileName} from the selected card.`);
    await dialog.locator('[data-sd-role="builder-send"]').click();
    await expect.poll(() => builderRequests().length).toBe(requestsBefore + 4);

    const requests = builderRequests().slice(requestsBefore);
    const results = requests[2].body;
    expect(toolResults(results, 'world_book_list')[0].result.books).toEqual([primary, auxiliary]);
    expect(toolResults(results, 'read_character_card')[0].avatar).toBe(avatar);
    const foreign = toolResults(requests[1].body, 'lorebook_get')[0];
    expect(foreign.ok).toBe(false);
    expect(foreign.error).toContain('not_allowed');
    expect(toolResults(results, 'lorebook_get').filter(result => result.ok).map(({ result }) => ({
        book: result.book_name,
        entries: result.entries.map(entry => ({ uid: entry.uid, content: entry.content })),
    }))).toEqual([primary, auxiliary].map(book => ({
        book,
        entries: [{ uid: 0, content: `Visual details from ${book}.` }],
    })));
    expect(results.messages.filter(message => message.role === 'user').flatMap(message => Array.isArray(message.content) ? message.content : [])
        .some(part => part.type === 'image_url' && part.image_url.url.startsWith('data:image/'))).toBe(true);

    await dialog.locator('[data-sd-role="builder-confirm"]').click();
    await expect(dialog).toBeHidden();

    const saved = Object.values(await readProfiles(page)).find(p => p.name === profileName);
    expect(saved).toBeTruthy();
    expect(saved).not.toHaveProperty('sourceCardAvatars');
    expect(saved.referenceImages[0].label).toBe('Travel outfit');
    const imagePath = saved.referenceImages[0].path;
    expect(imagePath).toMatch(/^\/user\/images\/_references\//);
    expect(existsSync(join(server.dataRoot, 'default-user', imagePath.replace(/^\//, '')))).toBe(true);
});

test('source images are staged without a vision message when inspection is disabled', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await configureSourceConnection(page, { visualInspection: false });
    const suffix = randomUUID();
    const avatar = await importSourceCard(page, `Source character ${suffix}`, '');
    const before = builderRequests().length;
    let round = 0;
    llm.scriptCompletion(() => round++ === 0 ? {
        tool: 'fetch_reference_image',
        arguments: { image_url: `/characters/${avatar}` },
    } : { text: 'The selected reference has been staged.' });

    const dialog = await openBuilderDialog(page);
    await dialog.locator('[data-sd-role="builder-source-select"]').selectOption(`card:${avatar}`);
    await dialog.locator('[data-sd-role="builder-input"]').fill('Fetch the card portrait without visual inspection.');
    await dialog.locator('[data-sd-role="builder-send"]').click();
    await expect.poll(() => builderRequests().length).toBe(before + 2);

    const messages = builderRequests()[before + 1].body;
    const staged = toolResults(messages, 'fetch_reference_image')[0];
    expect(staged.ok).toBe(true);
    expect(staged.imagePath).toMatch(/^\/user\/images\/_sandbox_tmp\//);
    expect(messages.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
        .filter(part => part.type === 'image_url')).toEqual([]);

    await dialog.locator('[data-sd-role="builder-cancel"]').click();
    await expect(dialog).toBeHidden();
});

async function createProfile(page) {
    const archive = await openArchive(page);
    await archive.locator('[data-sd-role="new-profile"]').first().click();
    const name = `Visual profile ${randomUUID()}`;
    await archive.locator('[data-sd-field="profile-name"]').fill(name);
    await archive.locator('[data-sd-role="save-profile"]').click();
    await expect.poll(async () => Object.values(await readProfiles(page))
        .find(profile => profile.name === name)?.id ?? '').not.toBe('');
    const profile = Object.values(await readProfiles(page)).find(entry => entry.name === name);
    return { archive, profile };
}

async function editInAnotherPage(context, profile) {
    const other = await context.newPage();
    await awaitMainUI(other, server.baseURL);
    const archive = await openArchive(other);
    await archive.locator(`[data-profile-id="${profile.id}"]`).click();
    await archive.locator('[data-sd-field="profile-description"]').fill('Silver hair, amber eyes.');
    await archive.locator('[data-sd-role="save-profile"]').click();
    await expect.poll(async () => (await readProfiles(other))[profile.id]?.description)
        .toBe('Silver hair, amber eyes.');
    return other;
}

test('profiles are global text records without card bindings', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    const { archive, profile } = await createProfile(page);
    await expect(archive.locator('.sdlens-chars-detail').getByRole('combobox', {
        name: await uiText(page, 'Source character card'),
        exact: true,
    })).toHaveCount(0);
    expect((await readProfiles(page))[profile.id]).not.toHaveProperty('sourceCardAvatars');
    await expect(archive.getByRole('button', {
        name: await uiText(page, 'Upload local reference image'),
        exact: true,
    })).toBeVisible();
});

test('rejectsConcurrentProfileUpdates without discarding the edited draft', async ({ page, context }) => {
    await awaitMainUI(page, server.baseURL);
    const { archive, profile } = await createProfile(page);
    const other = await editInAnotherPage(context, profile);
    try {
        const savedElsewhere = (await readProfiles(other))[profile.id];
        const editedName = `Revised profile ${randomUUID()}`;
        await archive.locator('[data-sd-field="profile-name"]').fill(editedName);
        await archive.locator('[data-sd-role="save-profile"]').click();
        await expect(page.getByText(await uiText(page, 'The character profile changed. Reload it before continuing.'), {
            exact: false,
        })).toBeVisible();
        await expect(archive.locator('[data-sd-field="profile-name"]')).toHaveValue(editedName);
        expect((await readProfiles(page))[profile.id]).toEqual(savedElsewhere);
    } finally {
        await other.close();
    }
});

test('a stale profile cannot delete a newer saved revision', async ({ page, context }) => {
    await awaitMainUI(page, server.baseURL);
    const { archive, profile } = await createProfile(page);
    const other = await editInAnotherPage(context, profile);
    try {
        const savedElsewhere = (await readProfiles(other))[profile.id];
        await archive.locator('[data-sd-role="delete-profile"]').click();
        await page.getByRole('alertdialog').getByRole('button', {
            name: await uiText(page, 'Confirm'),
            exact: true,
        }).click();
        await expect(page.getByText(await uiText(page, 'The character profile changed. Reload it before continuing.'), {
            exact: false,
        })).toBeVisible();
        expect((await readProfiles(page))[profile.id]).toEqual(savedElsewhere);
        await expect(archive.locator('[data-sd-field="profile-name"]')).toHaveValue(profile.name);
    } finally {
        await other.close();
    }
});
