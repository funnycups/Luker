import { test, expect } from '../../harness/playwright.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { bootstrapCustomBackend, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, openExtensionsDrawer, selectCharacterByName } from '../_lib/page.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';
import { read as readPngCard } from '../../../src/character-card-parser.js';
import { ensureOaiDrawerOpen } from './_helpers.js';

const AVATAR = 'bound-extension-watch.png';
const NAME = 'Keeper of the Bound Watch';
const PRESET = 'Bound Watch';
const OTHER_CHARACTER = 'Keeper of the Other Watch';
const LEGACY_AVATAR = 'legacy-bound-watch.png';
const LEGACY_CHARACTER = 'Keeper of the Legacy Watch';

const DEFAULT_PRESET = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../../../default/content/presets/openai/Default.json'), 'utf8'),
);

const INITIAL = {
    retained: 'namespace',
    chat_completion_preset: {
        presets: [
            {
                name: PRESET,
                preset: {
                    ...DEFAULT_PRESET,
                    temperature: 0.23,
                    extensions: { retained: 'preset', luker: { prompt_groups: [], prompt_layout: [] } },
                },
            },
            { name: 'Other Watch', preset: { temperature: 0.77 } },
        ],
        defaultPresetName: PRESET,
    },
};

let server;

const cardPath = (avatar = AVATAR) => resolve(server.dataRoot, 'default-user', 'characters', avatar);
const globalPresetPath = () => resolve(server.dataRoot, 'default-user', 'OpenAI Settings', PRESET + '.json');
const disk = (avatar = AVATAR) => JSON.parse(readPngCard(readFileSync(cardPath(avatar)))).data.extensions.luker;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    server = await startServer({ scope, batchKey: 'preset', scenarioId: 'bound-extension-save' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: 'http://127.0.0.1:1' });
    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: AVATAR,
        overrides: { name: NAME, extensions: { luker: INITIAL } },
    });
    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: 'other-bound-watch.png',
        overrides: { name: OTHER_CHARACTER },
    });
    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: LEGACY_AVATAR,
        overrides: {
            name: LEGACY_CHARACTER,
            extensions: {
                luker: { retained: 'legacy', chat_completion_preset: { name: PRESET, preset: INITIAL.chat_completion_preset.presets[0].preset } },
            },
        },
    });
});

test('prompt group DOM creation and preset regex editor save into the bound card slot without creating a global preset', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await expect.poll(() => page.evaluate(() => performance.getEntriesByName('[init] complete').some(entry => entry.entryType === 'mark'))).toBe(true);
    await selectCharacterByName(page, NAME);
    await expect(page.locator('#character_name_pole')).toHaveValue(NAME);
    await expect(page.locator('#settings_preset_openai option:checked')).toHaveAttribute('data-luker-char-bound', '1');

    const globalPresetRequests = [];
    page.on('request', r => { if (r.url().endsWith('/api/presets/save')) globalPresetRequests.push(r.postDataJSON()); });

    await ensureOaiDrawerOpen(page);
    await page.locator('#completion_prompt_manager_group_btn').click();
    const rows = page.locator('#completion_prompt_manager_list .prompt-manager-group-editing');
    await expect(rows.nth(1)).toBeVisible();
    await rows.nth(0).click();
    await rows.nth(1).click();
    await page.locator('.prompt-manager-group-create-btn').click();
    const groupPopup = page.locator('.popup:visible').last();
    await groupPopup.locator('textarea').fill('Watch group');
    await groupPopup.locator('.popup-button-ok').click();
    await expect.poll(() => page.evaluate(() => window.Luker.getContext().chatCompletionSettings.extensions.luker.prompt_groups.some(g => g.name === 'Watch group'))).toBe(true);

    await openExtensionsDrawer(page);
    const regexContent = page.locator('#regex_container .inline-drawer').first().locator('> .inline-drawer-content');
    if (!await regexContent.isVisible()) await page.locator('#regex_container .inline-drawer-toggle').first().click();
    await page.locator('#open_preset_editor').click();
    const regexPopup = page.locator('.popup:visible').last();
    await regexPopup.locator('input.regex_script_name').fill('Watch inscription');
    await regexPopup.locator('input.find_regex').fill('/dusk/g');
    await regexPopup.locator('textarea.regex_replace_string').fill('midnight');
    const savedResponse = page.waitForResponse(r => r.url().endsWith('/api/characters/merge-attributes') && r.status() === 200);
    await regexPopup.locator('.popup-button-ok').first().press('Enter');
    await savedResponse;
    await expect(regexPopup).toBeHidden();

    const saved = disk();
    expect(saved.retained).toBe('namespace');
    const savedSlot = saved.chat_completion_preset.presets[0].preset;
    expect(savedSlot.extensions.retained).toBe('preset');
    expect(savedSlot.extensions.luker.prompt_groups.some(g => g.name === 'Watch group')).toBe(true);
    expect(savedSlot.extensions.regex_scripts).toHaveLength(1);
    expect(savedSlot.extensions.regex_scripts[0]).toMatchObject({
        scriptName: 'Watch inscription',
        findRegex: '/dusk/g',
        replaceString: 'midnight',
    });
    expect(globalPresetRequests).toEqual([]);
    expect(existsSync(globalPresetPath())).toBe(false);

    // Switching away and back preserves the saved bound slot.
    await selectCharacterByName(page, OTHER_CHARACTER);
    await expect(page.locator('#character_name_pole')).toHaveValue(OTHER_CHARACTER);
    await selectCharacterByName(page, NAME);
    await expect(page.locator('#character_name_pole')).toHaveValue(NAME);
    await expect(page.locator('#settings_preset_openai option:checked')).toHaveAttribute('data-luker-char-bound', '1');
    expect(disk().chat_completion_preset.presets[0].preset.extensions.regex_scripts).toHaveLength(1);
});

test('legacy single binding normalizes on character selection and preserves retained namespace fields', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, LEGACY_CHARACTER);
    await expect(page.locator('#character_name_pole')).toHaveValue(LEGACY_CHARACTER);
    await expect.poll(() => disk(LEGACY_AVATAR).chat_completion_preset.presets?.map(p => p.name)).toEqual([PRESET]);
    const saved = disk(LEGACY_AVATAR);
    expect(saved.retained).toBe('legacy');
    expect(saved.chat_completion_preset.defaultPresetName).toBe(PRESET);
    expect(saved.chat_completion_preset.presets[0].preset.extensions.retained).toBe('preset');
});
