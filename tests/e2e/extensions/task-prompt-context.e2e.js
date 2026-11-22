// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { write as writePngCard } from '../../../src/character-card-parser.js';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import {
    awaitMainUI,
    closeExtensionsDrawer,
    closeRightNavDrawer,
    fillTopmostPopupAndAccept,
    openExtensionsDrawer,
    openInlineDrawer,
    sendMessageAndAwaitReply,
} from '../_lib/page.js';
import { openCharacterList } from '../_lib/ui-character.js';
import { importWorldDocument, openWorldInfoDrawer } from '../_lib/ui-worldinfo.js';

let server;
let llm;

// This imported CardApp is a real API consumer. Its floating task controls remain
// available when the user changes characters; no test globals or core substitutes
// are installed.
async function taskContextApplication(ctx) {
    const root = ctx.lukerContext;
    const panel = document.createElement('section');
    panel.id = 'task-context-application';
    panel.style.cssText = 'position:fixed;left:20px;top:180px;width:460px;max-height:65vh;overflow:auto;z-index:10000;background:var(--SmartThemeBlurTintColor);padding:12px';
    panel.innerHTML = [
        '<label>Connection<select data-task="connection"></select></label>',
        '<label>Completion preset<select data-task="preset"></select></label>',
        '<label>Scope<select data-task="scope"><option value="preset">Preset</option><option value="chat">Chat</option></select></label>',
        '<label>Input<textarea data-task="input"></textarea></label>',
        '<label><input type="checkbox" data-task="stream">Stream</label>',
        '<button data-task="capture">Capture context</button>',
        '<button data-task="run">Run task</button>',
        '<button data-task="stop">Stop task</button>',
        '<label>Variable scope<select data-task="variable-scope"><option value="local">Local</option><option value="global">Global</option></select></label>',
        '<label>Note<input data-task="note"></label>',
        '<button data-task="set-note">Save note</button>',
        '<button data-task="close">Close task</button>',
        '<pre data-task="status">ready</pre>',
        '<pre data-task="context"></pre>',
        '<pre data-task="prepared"></pre>',
        '<pre data-task="prepared-log">[]</pre>',
        '<pre data-task="result"></pre>',
    ].join('');
    document.body.append(panel);
    const field = name => panel.querySelector('[data-task="' + name + '"]');
    for (const profile of await root.connectionProfiles.list()) {
        field('connection').add(new Option(profile.name, profile.name));
    }
    for (const option of document.querySelector('#settings_preset_openai').options) {
        field('preset').add(new Option(option.textContent.trim(), option.textContent.trim()));
    }
    let snapshot;
    let owner;
    let controller;
    const perform = action => async () => {
        try {
            await action();
        } catch (error) {
            field('status').textContent = 'error';
            field('result').textContent = error.message;
        }
    };
    field('capture').onclick = perform(async () => {
        snapshot = await ctx.captureTaskPromptContext({
            scope: field('scope').value,
            apiPresetName: field('connection').value,
            llmPresetName: field('preset').value,
        });
        field('context').textContent = JSON.stringify(snapshot);
        field('status').textContent = 'captured';
    });
    field('set-note').onclick = perform(async () => {
        root.variables[field('variable-scope').value].set('snapshot_note', field('note').value);
        field('status').textContent = 'note saved';
    });
    field('run').onclick = perform(async () => {
        const { openTransientSession } = await import('/scripts/lib/transient-session.js');
        owner ??= await openTransientSession(root);
        controller = new AbortController();
        const preparedLog = [];
        field('prepared').textContent = '';
        field('prepared-log').textContent = '[]';
        const options = {
            taskMessages: [{ role: 'user', content: field('input').value }],
            apiPresetName: field('connection').value,
            llmPresetName: field('preset').value,
            promptContext: snapshot,
            transientSessionId: owner.sessionId,
            abortSignal: controller.signal,
            substituteMacros: true,
            onPreparedRequest: request => {
                preparedLog.push(request);
                field('prepared').textContent = JSON.stringify(request);
                field('prepared-log').textContent = JSON.stringify(preparedLog);
            },
        };
        field('status').textContent = 'running';
        let result;
        if (field('stream').checked) {
            const { stream, result: terminal } = root.generateTaskStream(options);
            const packets = [];
            for await (const packet of stream) packets.push(packet);
            result = { packets, terminal: await terminal };
        } else {
            result = await root.generateTask(options);
        }
        field('result').textContent = JSON.stringify(result);
        field('status').textContent = 'done';
    });
    field('stop').onclick = () => controller?.abort();
    field('close').onclick = perform(async () => {
        await owner?.close();
        panel.remove();
    });
}

test.beforeAll(async () => {
    llm = await startMockLLM({});
    llm.scriptCompletion(() => ({ text: 'The supplied task is complete.' }));
    server = await startServer({
        batchKey: 'extensions',
        scenarioId: 'task-prompt-context',
        extraConfig: { enableUserAccounts: false, disableUpdateCheck: true },
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await llm?.stop();
});

async function configureConnection(page) {
    await page.locator('#API-status-top').click();
    await page.locator('#main_api').selectOption('openai');
    await page.locator('#chat_completion_source').selectOption('custom');
    await page.locator('#custom_api_url_text').fill(llm.baseURL);
    await page.locator('#custom_api_url_text').press('Tab');
    await page.locator('#api_button_openai').click();
    await expect(page.locator('#model_custom_select option[value="mock-gpt-4o"]')).toHaveCount(1);
    await page.locator('#model_custom_select').selectOption('mock-gpt-4o');
    await page.locator('#custom_prompt_post_processing').selectOption('');
    const preset = (await page.locator('#settings_preset_openai option:checked').textContent()).trim();
    const connection = `Task connection ${randomUUID()}`;
    await page.locator('#create_connection_profile').click();
    await fillTopmostPopupAndAccept(page, connection);
    await expect(page.locator('#connection_profiles option', { hasText: connection })).toHaveCount(1);
    await page.locator('#API-status-top').click();
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'sd_illustration_container');
    await page.locator('#sd_illustration_enabled').uncheck();
    await closeExtensionsDrawer(page);
    return { connection, preset };
}

async function importSnapshotRegex(page) {
    const marker = `snapshot_filter_${randomUUID()}`;
    const scriptName = `Captured filter ${randomUUID()}`;
    const placement = await page.evaluate(async () => {
        const { regex_placement } = await import('/scripts/extensions/regex/engine.js');
        return regex_placement.USER_INPUT;
    });
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'regex_container');
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#import_regex').click();
    await (await chooser).setFiles({
        name: 'captured-filter.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify({
            scriptName,
            findRegex: marker,
            replaceString: '{{getvar::snapshot_note}}',
            trimStrings: [],
            placement: [placement],
            pluginLanes: ['request'],
            substituteRegex: 0,
            disabled: false,
            runOnEdit: true,
        })),
    });
    const popup = page.locator('.popup:visible').last();
    await expect(popup.locator('#regex_import_target_global')).toBeChecked();
    await popup.locator('.popup-button-ok').click();
    await expect.poll(() => JSON.parse(readFileSync(join(server.dataRoot, 'default-user/settings.json'), 'utf8'))
        .extension_settings.regex?.some(script => script.scriptName === scriptName)).toBe(true);
    await closeExtensionsDrawer(page);
    return marker;
}

async function importContextCard(page, { application = false, overrides = {} } = {}) {
    const id = randomUUID();
    const card = {
        name: `Context source ${id}`,
        description: `A traveler carrying a sealed copper case ${id}.`,
        personality: `Careful and observant ${id}.`,
        scenario: `A meeting beside the library entrance ${id}.`,
        first_mes: `The traveler places the copper case on the table ${id}.`,
        system_prompt: `Speak as the traveler with the copper case ${id}.`,
        post_history_instructions: `Keep the copper case closed ${id}.`,
        ...overrides,
        extensions: {
            ...overrides.extensions,
            ...(application ? { card_app: {
                enabled: true,
                entry: 'index.js',
                files: { 'index.js': `export const init = ${taskContextApplication.toString()};` },
            } } : {}),
        },
    };
    const png = writePngCard(
        readFileSync(join(import.meta.dirname, '../../../default/content/default_Seraphina.png')),
        JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: card }),
    );
    await openCharacterList(page);
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#character_import_button').click();
    const response = page.waitForResponse(reply => reply.request().method() === 'POST'
        && new URL(reply.url()).pathname === '/api/characters/import');
    await (await chooser).setFiles({ name: `context-${id}.png`, mimeType: 'image/png', buffer: png });
    expect((await response).ok()).toBeTruthy();
    await page.locator('#rm_print_characters_block .character_select').filter({
        has: page.locator('.ch_name', { hasText: card.name }),
    }).click();
    await expect(page.locator('#character_name_pole')).toHaveValue(card.name);
    return card;
}

async function prepareApplication(page, { cardOverrides = {} } = {}) {
    await awaitMainUI(page, server.baseURL);
    const pair = await configureConnection(page);
    const card = await importContextCard(page, { application: true, overrides: cardOverrides });
    const panel = page.locator('#task-context-application');
    await expect(panel).toBeVisible();
    await panel.locator('[data-task="connection"]').selectOption(pair.connection);
    await panel.locator('[data-task="preset"]').selectOption(pair.preset);
    return { panel, card };
}

function generationRequests() {
    return llm.requests.filter(request => new URL(request.url, llm.baseURL).pathname.endsWith('/chat/completions'));
}

test('isolatesPresetPromptContext from the active card and variables', async ({ page }) => {
    const { panel, card } = await prepareApplication(page);
    await panel.locator('[data-task="note"]').fill('A note belonging to this conversation.');
    await panel.locator('[data-task="set-note"]').click();
    await expect(panel.locator('[data-task="status"]')).toHaveText('note saved');
    await panel.locator('[data-task="variable-scope"]').selectOption('global');
    await panel.locator('[data-task="note"]').fill('A note belonging to global settings.');
    await panel.locator('[data-task="set-note"]').click();
    await expect(panel.locator('[data-task="status"]')).toHaveText('note saved');
    await panel.locator('[data-task="scope"]').selectOption('preset');
    await panel.locator('[data-task="capture"]').click();
    await expect(panel.locator('[data-task="status"]')).toHaveText('captured');
    const snapshot = JSON.parse(await panel.locator('[data-task="context"]').textContent());
    expect(snapshot.envelope).not.toHaveProperty('characterCard');
    expect(snapshot.envelope.promptCore.sysprompt.cardSystemPrompt).toBe('');
    expect(snapshot.envelope.promptCore.sysprompt.cardPostHistory).toBe('');
    await panel.locator('[data-task="input"]').fill([
        '{{description}}', '{{charPrompt}}', '{{charInstruction}}', '{{persona}}',
        '{{lastMessage}}', '{{getvar::snapshot_note}}', '{{getglobalvar::snapshot_note}}',
        '{{.snapshot_note}}', '{{$snapshot_note}}',
        'Describe the supplied visual request.',
    ].join('\n'));
    const before = generationRequests().length;
    await panel.locator('[data-task="run"]').click();
    await expect(panel.locator('[data-task="status"]')).toHaveText('done');
    expect(generationRequests().length).toBe(before + 1);
    const actual = generationRequests().at(-1).body;
    const captured = JSON.parse(await panel.locator('[data-task="prepared"]').textContent());
    expect(captured.payload.messages).toEqual(actual.messages);
    expect(captured.payload.user_name).toBe('');
    expect(captured.payload.char_name).toBe('');
    expect(captured.payload.group_names).toEqual([]);
    const sent = JSON.stringify(actual.messages);
    for (const value of [card.description, card.system_prompt, card.post_history_instructions, card.first_mes,
        'A note belonging to this conversation.', 'A note belonging to global settings.']) expect(sent).not.toContain(value);
    await panel.locator('[data-task="close"]').click();
});

test('a captured chat remains fixed after changing characters', async ({ page }) => {
    const { panel, card } = await prepareApplication(page);
    await panel.locator('[data-task="note"]').fill('The original conversation note.');
    await panel.locator('[data-task="set-note"]').click();
    await expect(panel.locator('[data-task="status"]')).toHaveText('note saved');
    await panel.locator('[data-task="scope"]').selectOption('chat');
    await panel.locator('[data-task="capture"]').click();
    await expect(panel.locator('[data-task="status"]')).toHaveText('captured');
    const original = JSON.parse(await panel.locator('[data-task="context"]').textContent());
    expect(original.envelope.characterCard.description).toBe(card.description);
    const other = await importContextCard(page);
    await panel.locator('[data-task="note"]').fill('The other conversation note.');
    await panel.locator('[data-task="set-note"]').click();
    await expect(panel.locator('[data-task="status"]')).toHaveText('note saved');
    await panel.locator('[data-task="input"]').fill('{{description}}\n{{lastMessage}}\n{{getvar::snapshot_note}}');
    await panel.locator('[data-task="run"]').click();
    await expect(panel.locator('[data-task="status"]')).toHaveText('done');
    const actual = generationRequests().at(-1).body;
    const captured = JSON.parse(await panel.locator('[data-task="prepared"]').textContent());
    expect(captured.payload.messages).toEqual(actual.messages);
    expect(captured.payload.char_name).toBe(card.name);
    const sent = JSON.stringify(actual.messages);
    expect(sent).toContain(card.description);
    expect(sent).toContain('The original conversation note.');
    for (const value of [other.description, other.system_prompt, other.post_history_instructions,
        other.first_mes, 'The other conversation note.']) expect(sent).not.toContain(value);
    await panel.locator('[data-task="close"]').click();
});

test('nested native macros read only captured variables', async ({ page }) => {
    const { panel } = await prepareApplication(page);
    await panel.locator('[data-task="note"]').fill('["first_snapshot_entry","second_snapshot_entry"]');
    await panel.locator('[data-task="set-note"]').click();
    await expect(panel.locator('[data-task="status"]')).toHaveText('note saved');
    await panel.locator('[data-task="scope"]').selectOption('chat');
    await panel.locator('[data-task="capture"]').click();
    await expect(panel.locator('[data-task="status"]')).toHaveText('captured');
    await panel.locator('[data-task="note"]').fill('["live_snapshot_entry"]');
    await panel.locator('[data-task="set-note"]').click();
    await expect(panel.locator('[data-task="status"]')).toHaveText('note saved');
    await panel.locator('[data-task="input"]').fill([
        '{{each::snapshot_note}}{{loop_value}}|{{/each}}',
        '{{if .snapshot_note}}{{getvar::snapshot_note}}{{/if}}',
        '{{.snapshot_note}}',
    ].join('\n'));
    await panel.locator('[data-task="run"]').click();
    await expect(panel.locator('[data-task="status"]')).toHaveText('done');
    const sent = JSON.stringify(generationRequests().at(-1).body.messages);
    expect(sent).toContain('first_snapshot_entry|second_snapshot_entry|');
    expect(sent).toContain('second_snapshot_entry');
    expect(sent).not.toContain('live_snapshot_entry');
    await panel.locator('[data-task="close"]').click();
});

test('capturing card fields cannot run live variable mutations', async ({ page }) => {
    const { panel } = await prepareApplication(page, {
        cardOverrides: { description: '{{setglobalvar::snapshot_note::changed_during_capture}}A supplied appearance.' },
    });
    await panel.locator('[data-task="variable-scope"]').selectOption('global');
    await panel.locator('[data-task="note"]').fill('Keep this variable unchanged.');
    await panel.locator('[data-task="set-note"]').click();
    await expect(panel.locator('[data-task="status"]')).toHaveText('note saved');
    await panel.locator('[data-task="capture"]').click();
    await expect(panel.locator('[data-task="status"]')).toHaveText('captured');
    expect(await page.evaluate(() => window.Luker.getContext().extensionSettings.variables.global.snapshot_note))
        .toBe('Keep this variable unchanged.');
    await panel.locator('[data-task="scope"]').selectOption('chat');
    await panel.locator('[data-task="capture"]').click();
    await expect(panel.locator('[data-task="status"]')).toHaveText('error');
    expect(await page.evaluate(() => window.Luker.getContext().extensionSettings.variables.global.snapshot_note))
        .toBe('Keep this variable unchanged.');
    await panel.locator('[data-task="close"]').click();
});

test('captured world info remains private to the task snapshot', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    const name = `Context world ${randomUUID()}`;
    const content = 'The supplied visual setting uses layered linen coats.';
    await importWorldDocument(page, name, {
        entries: { 0: { uid: 0, key: [], comment: 'Visual setting', content, constant: true, position: 0, order: 100, disable: false } },
    });
    const { panel } = await prepareApplication(page, { cardOverrides: { extensions: { world: name } } });
    await panel.locator('[data-task="scope"]').selectOption('chat');
    await panel.locator('[data-task="capture"]').click();
    await expect(panel.locator('[data-task="status"]')).toHaveText('captured');
    const snapshot = JSON.parse(await panel.locator('[data-task="context"]').textContent());
    expect(snapshot.runtimeWorldInfo.worldInfoBeforeEntries).toContain(content);
    await panel.locator('[data-task="close"]').click();
    await openWorldInfoDrawer(page);
    const managerHeader = page.locator('.world_info_manager_drawer_header');
    if (!(await page.locator('#world_info_manager_search').isVisible())) await managerHeader.click();
    await page.locator('#world_info_manager_search').fill(name);
    await page.locator('.world_info_manager_item_title').filter({ hasText: name }).click();
    await page.locator('.trace_activation_button:visible').first().click();
    const noTrace = await page.evaluate(() => window.Luker.getContext().translate('No activation trace yet'));
    await expect(page.locator('.popup:visible').last().getByText(noTrace, { exact: true })).toBeVisible();
    await page.locator('.popup:visible').last().locator('.popup-button-ok').click();
});

test('captured world-book macros cannot mutate live variables', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    const name = `Context world ${randomUUID()}`;
    await importWorldDocument(page, name, {
        entries: { 0: {
            uid: 0, key: [], comment: 'Visual setting',
            content: '{{setglobalvar::snapshot_note::changed_during_world_scan}}A supplied visual setting.',
            constant: true, position: 0, order: 100, disable: false,
        } },
    });
    const { panel } = await prepareApplication(page, { cardOverrides: { extensions: { world: name } } });
    await panel.locator('[data-task="variable-scope"]').selectOption('global');
    await panel.locator('[data-task="note"]').fill('Keep this variable unchanged.');
    await panel.locator('[data-task="set-note"]').click();
    await expect(panel.locator('[data-task="status"]')).toHaveText('note saved');
    await panel.locator('[data-task="scope"]').selectOption('chat');
    await panel.locator('[data-task="capture"]').click();
    await expect.soft(panel.locator('[data-task="status"]')).toHaveText('error');
    expect(await page.evaluate(() => window.Luker.getContext().extensionSettings.variables.global.snapshot_note))
        .toBe('Keep this variable unchanged.');
    await panel.locator('[data-task="close"]').click();
});

for (const scope of ['preset', 'chat']) {
    test(`captured ${scope} regex substitutions do not read later conversation variables`, async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        const marker = await importSnapshotRegex(page);
        const { panel } = await prepareApplication(page);
        await panel.locator('[data-task="note"]').fill('The captured filter value.');
        await panel.locator('[data-task="set-note"]').click();
        await expect(panel.locator('[data-task="status"]')).toHaveText('note saved');
        await panel.locator('[data-task="scope"]').selectOption(scope);
        await panel.locator('[data-task="capture"]').click();
        await expect(panel.locator('[data-task="status"]')).toHaveText('captured');
        await panel.locator('[data-task="note"]').fill('The later filter value.');
        await panel.locator('[data-task="set-note"]').click();
        await expect(panel.locator('[data-task="status"]')).toHaveText('note saved');
        await panel.locator('[data-task="input"]').fill(`${marker}\nDescribe the requested appearance.`);
        await panel.locator('[data-task="run"]').click();
        await expect(panel.locator('[data-task="status"]')).toHaveText('done');
        const sent = JSON.stringify(generationRequests().at(-1).body.messages);
        expect(sent).not.toContain('The later filter value.');
        if (scope === 'chat') expect(sent).toContain('The captured filter value.');
        else expect(sent).not.toContain('The captured filter value.');
        await panel.locator('[data-task="close"]').click();
    });
}

for (const input of [
    '{{unavailable_snapshot_macro}}',
    '{{setglobalvar::snapshot_note::changed}}',
    '{{roll::not_a_dice_formula}}',
    '{{$snapshot_note > 0}}',
]) {
    test(`captured tasks reject unsafe or invalid macro evaluation: ${input}`, async ({ page }) => {
        const { panel } = await prepareApplication(page);
        await panel.locator('[data-task="variable-scope"]').selectOption('global');
        await panel.locator('[data-task="note"]').fill('Keep this variable unchanged.');
        await panel.locator('[data-task="set-note"]').click();
        await expect(panel.locator('[data-task="status"]')).toHaveText('note saved');
        await panel.locator('[data-task="scope"]').selectOption('chat');
        await panel.locator('[data-task="capture"]').click();
        await expect(panel.locator('[data-task="status"]')).toHaveText('captured');
        await panel.locator('[data-task="input"]').fill(input);
        const before = generationRequests().length;
        await panel.locator('[data-task="run"]').click();
        await expect(panel.locator('[data-task="status"]')).toHaveText('error');
        await expect(panel.locator('[data-task="result"]')).not.toHaveText('');
        expect(generationRequests().length).toBe(before);
        expect(await page.evaluate(() => window.Luker.getContext().extensionSettings.variables.global.snapshot_note))
            .toBe('Keep this variable unchanged.');
        await panel.locator('[data-task="close"]').click();
    });
}

for (const stream of [false, true]) {
    test(`capturesFinalTaskRequests through the real ${stream ? 'streaming' : 'non-streaming'} sender`, async ({ page }) => {
        const { panel } = await prepareApplication(page);
        await panel.locator('[data-task="stream"]').setChecked(stream);
        await panel.locator('[data-task="input"]').fill('Describe the appearance requested by the user.');
        const before = generationRequests().length;
        await panel.locator('[data-task="run"]').click();
        await expect(panel.locator('[data-task="status"]')).toHaveText('done');
        await expect(panel.locator('[data-task="prepared"]')).not.toHaveText('');
        expect(generationRequests().length).toBe(before + 1);
        const captured = JSON.parse(await panel.locator('[data-task="prepared"]').textContent());
        expect(captured.payload.messages).toEqual(generationRequests().at(-1).body.messages);
        await panel.locator('[data-task="close"]').click();
    });
}

test('transient tasks retry without profile timeout and stay out of request inspection', async ({ page }) => {
    const { panel } = await prepareApplication(page);
    await page.locator('#API-status-top').click();
    await openInlineDrawer(page, 'rm_api_block');
    await page.locator('#connection_profile_max_request_retries').scrollIntoViewIfNeeded();
    await page.locator('#connection_profile_max_request_retries').fill('1');
    await page.locator('#connection_profile_max_request_retries').dispatchEvent('change');
    await page.locator('#connection_profile_request_timeout').scrollIntoViewIfNeeded();
    await page.locator('#connection_profile_request_timeout').fill('1');
    await page.locator('#connection_profile_request_timeout').dispatchEvent('change');
    await page.locator('#API-status-top').click();

    await panel.locator('[data-task="scope"]').selectOption('preset');
    await panel.locator('[data-task="capture"]').click();
    await expect(panel.locator('[data-task="status"]')).toHaveText('captured');

    const beforeInspections = await page.evaluate(async () => {
        const res = await fetch('/api/request-inspector/list');
        return (await res.json()).map(entry => entry.id);
    });
    const beforeCount = generationRequests().length;
    let attempts = 0;
    llm.setChatCompletionFailure(() => {
        attempts += 1;
        return attempts === 1 ? { status: 500, body: 'temporary upstream error' } : null;
    });
    llm.setLatencyMs(() => (attempts >= 2 ? 1500 : 0));
    try {
        await panel.locator('[data-task="input"]').fill('Retry and ignore configured timeout.');
        await panel.locator('[data-task="run"]').click();
        await expect(panel.locator('[data-task="status"]')).toHaveText('done', { timeout: 20_000 });
    } finally {
        llm.setChatCompletionFailure(null);
        llm.setLatencyMs(0);
    }

    const recent = generationRequests().slice(beforeCount);
    expect(recent).toHaveLength(2);
    const preparedLog = JSON.parse(await panel.locator('[data-task="prepared-log"]').textContent());
    expect(preparedLog).toHaveLength(2);
    expect(preparedLog[1].payload.messages).toEqual(recent[1].body.messages);
    expect(recent[1].body.request_timeout_ms).toBeUndefined();

    const afterInspections = await page.evaluate(async () => {
        const res = await fetch('/api/request-inspector/list');
        return (await res.json()).map(entry => entry.id);
    });
    expect(afterInspections).toEqual(beforeInspections);
    await panel.locator('[data-task="close"]').click();
});

test('stopping a private task aborts cleanly while ordinary chat continues recording normally', async ({ page }) => {
    const { panel } = await prepareApplication(page);
    await panel.locator('[data-task="scope"]').selectOption('preset');
    await panel.locator('[data-task="capture"]').click();
    await expect(panel.locator('[data-task="status"]')).toHaveText('captured');

    const beforeAbortCount = generationRequests().length;
    llm.setLatencyMs(15_000);
    try {
        await panel.locator('[data-task="input"]').fill('Wait to be stopped by the user.');
        await panel.locator('[data-task="run"]').click();
        await expect.poll(() => generationRequests().length).toBeGreaterThan(beforeAbortCount);
        await panel.locator('[data-task="stop"]').click();
        await expect(panel.locator('[data-task="status"]')).toHaveText('error');
    } finally {
        llm.setLatencyMs(0);
    }

    await importContextCard(page);
    await closeRightNavDrawer(page);
    const beforeChatInspections = await page.evaluate(async () => {
        const res = await fetch('/api/request-inspector/list');
        return (await res.json()).map(entry => entry.id);
    });
    const reply = await sendMessageAndAwaitReply(page, 'Confirm ordinary chat works.');
    expect(reply.text).toContain('The supplied task is complete.');
    const afterChatInspections = await page.evaluate(async () => {
        const res = await fetch('/api/request-inspector/list');
        return (await res.json()).map(entry => entry.id);
    });
    expect(afterChatInspections.length).toBeGreaterThan(beforeChatInspections.length);

    const chatBeforePrivate = await page.evaluate(() => window.Luker.getContext().chat.map(m => m.mes));
    const privateMarker = `Run a private task after ordinary chat ${randomUUID()}.`;
    await panel.locator('[data-task="input"]').fill(privateMarker);
    await panel.locator('[data-task="run"]').click();
    await expect(panel.locator('[data-task="status"]')).toHaveText('done');

    const inspectionState = await page.evaluate(async () => {
        const list = await (await fetch('/api/request-inspector/list')).json();
        const details = await Promise.all(list.map(async entry => (await fetch(`/api/request-inspector/${entry.id}`)).json()));
        return { ids: list.map(entry => entry.id), details };
    });
    expect(inspectionState.ids).toEqual(expect.arrayContaining(afterChatInspections));
    expect(JSON.stringify(inspectionState.details)).not.toContain(privateMarker);
    const chatAfterPrivate = await page.evaluate(() => window.Luker.getContext().chat.map(m => m.mes));
    expect(chatAfterPrivate).toEqual(chatBeforePrivate);
    await panel.locator('[data-task="close"]').click();
});
