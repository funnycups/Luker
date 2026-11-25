import { test, expect } from '../../harness/playwright.js';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer } from '../../harness/server.js';
import { bootstrapCustomBackend, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, openExtensionsDrawer, selectCharacterByName } from '../_lib/page.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';
import { read as readPngCard } from '../../../src/character-card-parser.js';
import { ensureOaiDrawerOpen } from './_helpers.js';
import { observeOperations } from '../../harness/observations.js';

const AVATAR = 'bound-extension-watch.png';
const NAME = 'Keeper of the Bound Watch';
const PRESET = 'Bound Watch';
const OTHER_CHARACTER = 'Keeper of the Other Watch';
const SAME_NAME_AVATAR = 'same-name-bound-watch.png';
const SAME_NAME_CHARACTER = 'Keeper of the Distant Watch';
const LEGACY_AVATAR = 'legacy-bound-watch.png';
const LEGACY_CHARACTER = 'Keeper of the Legacy Watch';

const DEFAULT_PRESET = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../../../default/content/presets/openai/Default.json'), 'utf8'),
);

const INITIAL = {
    retained: 'namespace',
    chat_completion_preset: {
        presets: [
            { name: PRESET, preset: { ...DEFAULT_PRESET, temperature: 0.23, extensions: { retained: 'preset' } } },
            { name: 'Other Watch', preset: { temperature: 0.77 } },
        ],
        defaultPresetName: PRESET,
    },
};

const ENTRY = `export function init(ctx) {
    const live = ctx.lukerContext;
    const result = document.createElement('pre'); result.id = 'bound-result';
    const input = document.createElement('input'); input.id = 'bound-value'; input.value = 'dusk';
    const add = (id, action) => {
        const b = document.createElement('button');
        b.id = 'bound-' + id;
        b.textContent = id;
        b.onclick = async () => {
            result.textContent = 'pending';
            try {
                await action();
                result.textContent = JSON.stringify({ ok: true });
            } catch (e) {
                result.textContent = JSON.stringify({ ok: false, error: e.message });
            } finally {
                result.dataset.last = id;
            }
        };
        ctx.container.append(b);
    };

    const cardFor = () => live.characters.find(c => c.avatar === ${JSON.stringify(AVATAR)});
    const slotFor = () => live.character.presets.list(cardFor()).find(p => p.name === ${JSON.stringify(PRESET)});
    const stamp = () => { live.extensionSettings.boundPathAttempt = input.value; };

    add('reset', async () => {
        const next = ${JSON.stringify(INITIAL)};
        next.chat_completion_preset.presets[0].preset = {
            ...live.getPresetManager('openai').getPresetSettings(),
            temperature: 0.23,
            n: 1,
            seed: -1,
            extensions: { retained: 'preset', luker: { prompt_groups: [], prompt_layout: [] } },
        };
        await live.writeExtensionField(live.characters.findIndex(c => c.avatar === ${JSON.stringify(AVATAR)}), 'luker', next);
    });
    add('save', async () => {
        await live.getPresetManager('openai').writePresetExtensionField({ path: 'watch.value', value: { bell: input.value } });
    });

    let retainedPresetBody;
    add('save-live', async () => {
        const pm = live.getPresetManager('openai');
        retainedPresetBody = pm.getPresetList().presets[Number(pm.getSelectedPreset())];
        retainedPresetBody.temperature = 0.61;
        retainedPresetBody.extensions = { ...retainedPresetBody.extensions, watch: { value: input.value } };
        await pm.savePreset(${JSON.stringify(PRESET)}, retainedPresetBody, { skipUpdate: true });
    });
    add('mutate-live', async () => {
        retainedPresetBody.temperature = 0.99;
        retainedPresetBody.extensions.watch.value = 'later argument edit';
    });
    add('save-native', async () => {
        live.chatCompletionSettings.temp_openai = 0.61;
        live.chatCompletionSettings.extensions = { ...live.chatCompletionSettings.extensions, watch: { value: input.value } };
        await live.openai.savePreset(${JSON.stringify(PRESET)}, live.chatCompletionSettings, false);
    });
    add('context', async () => {
        await live.presets.writeExtensions({ collection: 'openai', name: ${JSON.stringify(PRESET)} }, 'watch.value', { bell: input.value });
    });
    add('siblings', async () => {
        const pm = live.getPresetManager('openai');
        await Promise.all([
            pm.writePresetExtensionField({ path: 'watch.first', value: 'dawn' }),
            pm.writePresetExtensionField({ path: 'watch.second', value: 'noon' }),
        ]);
    });
    add('nested-seed', async () => {
        await live.getPresetManager('openai').writePresetExtensionField({
            path: 'watch.nested',
            value: { branch: { kept: 'seed' }, list: [{ kept: 'seed' }] },
        });
    });
    add('nested-isolate', async () => {
        const payload = {
            path: 'watch.nested',
            value: { branch: { kept: 'intent', nan: NaN, omitted: undefined }, list: [{ kept: 'intent' }, undefined, , Infinity] },
        };
        const pending = live.getPresetManager('openai').writePresetExtensionField(payload);
        const published = live.chatCompletionSettings.extensions.watch.nested;
        published.branch.kept = 'live-edit';
        published.list[0].kept = 'live-edit';
        payload.value.branch.kept = 'argument-edit';
        payload.value.list[0].kept = 'argument-edit';
        await pending;
    });
    add('global', async () => {
        await live.getPresetManager('openai').savePreset(${JSON.stringify(PRESET)}, { temperature: 0.91, extensions: { globalSibling: true } }, { skipUpdate: false });
    });
    add('binding', async () => {
        await live.character.presets.setDefault(cardFor(), 'Other Watch');
    });
    add('namespace', async () => {
        await live.writeExtensionField(live.characters.findIndex(c => c.avatar === ${JSON.stringify(AVATAR)}), 'luker', current => ({ ...current, laterSibling: 'retained' }));
    });
    add('capture', async () => {
        const value = { bell: input.value };
        const path = ['watch', 'captured'];
        const pending = live.getPresetManager('openai').writePresetExtensionField({ path, value });
        value.bell = 'mutated';
        path[1] = 'wrong';
        await pending;
    });
    add('unrelated', async () => {
        await live.getPresetManager('context').writePresetExtensionField({ path: 'watch', value: 'context' });
    });
    add('ordinary', async () => {
        await live.saveSettings(0, {});
    });
    add('delete', async () => {
        await live.getPresetManager('openai').deletePreset(${JSON.stringify(PRESET)});
    });
    add('replace', async () => {
        await live.getPresetManager('openai').savePreset(${JSON.stringify(PRESET)}, { temperature: 0.88, extensions: { replacement: true } }, { skipUpdate: false });
    });
    add('rename', async () => {
        const pm = live.getPresetManager('openai');
        await pm.savePreset('Renamed Watch', pm.getStoredPreset(${JSON.stringify(PRESET)}), { skipUpdate: false });
        await pm.deletePreset(${JSON.stringify(PRESET)});
    });
    let options;
    add('options', async () => {
        options = { presetExtensionWrite: false };
        await live.saveSettings(0, options);
    });
    add('mutate-options', async () => {
        options.presetExtensionWrite = true;
        options.cardPresetOwner = { source: { defaultPresetName: 'wrong' } };
    });
    add('later-sampler', async () => {
        await live.character.presets.update(cardFor(), ${JSON.stringify(PRESET)}, { ...slotFor().preset, temperature: 0.88 });
    });
    add('pending-object', async () => {
        live.chatCompletionSettings.extensions.watch = { a: 1 };
    });
    add('later-object', async () => {
        const slot = slotFor();
        await live.character.presets.update(cardFor(), ${JSON.stringify(PRESET)}, { ...slot.preset, extensions: { ...slot.preset.extensions, watch: { later: true } } });
    });
    add('pending-groups', async () => {
        live.chatCompletionSettings.extensions.luker = {
            prompt_groups: [{ id: 'watch-group', name: 'Watch group', identifiers: ['main'] }],
            prompt_layout: [{ type: 'group', id: 'watch-group' }],
        };
    });
    add('later-groups', async () => {
        const slot = slotFor();
        await live.character.presets.update(cardFor(), ${JSON.stringify(PRESET)}, {
            ...slot.preset,
            extensions: { ...slot.preset.extensions, luker: { prompt_groups: [], prompt_layout: [{ type: 'prompt', identifier: 'later' }] } },
        });
    });
    add('seed-paths', async () => {
        const pm = live.getPresetManager('openai');
        await pm.writePresetExtensionField({ path: 'watch', value: { value: 1 } });
        await pm.writePresetExtensionField({ path: 'items', value: [{ enabled: false, retained: true }] });
    });
    add('empty-array', async () => {
        stamp();
        await live.getPresetManager('openai').writePresetExtensionField({ path: [], value: { replacement: true } });
    });
    add('empty-carried', async () => {
        live.chatCompletionSettings.temp_openai = 0.61;
        live.chatCompletionSettings.extensions.watch.carried = 'acknowledged';
        stamp();
        await live.getPresetManager('openai').writePresetExtensionField({ path: [], value: { replacement: true } });
    });
    add('root-replace', async () => {
        stamp();
        await live.getPresetManager('openai').writePresetExtensionField({ path: '', value: { replacement: true } });
    });
    add('same-nested', async () => {
        stamp();
        await live.getPresetManager('openai').writePresetExtensionField({ path: 'watch.value', value: 1 });
    });
    add('same-root', async () => {
        stamp();
        await live.getPresetManager('openai').writePresetExtensionField({ path: '', value: live.chatCompletionSettings.extensions });
    });
    add('index-bracket', async () => {
        stamp();
        await live.getPresetManager('openai').writePresetExtensionField({ path: 'items[0].enabled', value: true });
    });
    add('index-array', async () => {
        stamp();
        const path = ['items', 0, 'enabled'];
        const pending = live.getPresetManager('openai').writePresetExtensionField({ path, value: true });
        path[1] = 1;
        path[2] = 'wrong';
        await pending;
    });
    add('later-value', async () => {
        const slot = slotFor();
        await live.character.presets.update(cardFor(), ${JSON.stringify(PRESET)}, { ...slot.preset, extensions: { ...slot.preset.extensions, watch: { value: 2 } } });
    });
    add('later-items', async () => {
        const slot = slotFor();
        await live.character.presets.update(cardFor(), ${JSON.stringify(PRESET)}, {
            ...slot.preset,
            extensions: { ...slot.preset.extensions, items: [{ later: true }, ...slot.preset.extensions.items] },
        });
    });
    add('seed-literal', async () => {
        const slot = slotFor();
        await live.character.presets.update(cardFor(), ${JSON.stringify(PRESET)}, {
            ...slot.preset,
            extensions: { ...slot.preset.extensions, 'items[0].enabled': false, 'watch.value': 1 },
        });
    });
    add('later-literal', async () => {
        const slot = slotFor();
        await live.character.presets.update(cardFor(), ${JSON.stringify(PRESET)}, {
            ...slot.preset,
            extensions: { ...slot.preset.extensions, 'watch.value': 2 },
        });
    });
    const wireValue = () => ({ retained: 'wire', nan: NaN, infinite: Infinity, omitted: undefined, items: [undefined, , NaN, { retained: true, omitted: undefined }] });
    add('wire-object', async () => {
        await live.getPresetManager('openai').writePresetExtensionField({ path: 'watch.wire', value: wireValue() });
    });
    add('wire-delete', async () => {
        await live.getPresetManager('openai').writePresetExtensionField({ path: 'watch.wire', value: undefined });
    });
    add('wire-unsupported', async () => {
        await live.getPresetManager('openai').writePresetExtensionField({ path: 'watch.wire', value: () => 'unsupported' });
    });
    ctx.container.append(input, result);
}`;

let server;
let baseline;

const cardPath = (avatar = AVATAR) => resolve(server.dataRoot, 'default-user', 'characters', avatar);
const globalPresetPath = () => resolve(server.dataRoot, 'default-user', 'OpenAI Settings', PRESET + '.json');
const disk = (avatar = AVATAR) => JSON.parse(readPngCard(readFileSync(cardPath(avatar)))).data.extensions.luker;
const storedSettings = () => JSON.parse(readFileSync(resolve(server.dataRoot, 'default-user', 'settings.json'), 'utf8'));

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    server = await startServer({ scope, batchKey: 'preset', scenarioId: 'bound-extension-save' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: 'http://127.0.0.1:1' });
    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: AVATAR,
        overrides: { name: NAME, extensions: { luker: INITIAL, card_app: { enabled: true, entry: 'index.js', files: { 'index.js': ENTRY } } } },
    });
    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: 'other-bound-watch.png',
        overrides: { name: OTHER_CHARACTER },
    });
    const sameName = structuredClone(INITIAL);
    sameName.chat_completion_preset.presets[0].preset.temperature = 0.79;
    sameName.chat_completion_preset.presets[0].preset.extensions.watch = { distant: true };
    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: SAME_NAME_AVATAR,
        overrides: { name: SAME_NAME_CHARACTER, extensions: { luker: sameName } },
    });
    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: LEGACY_AVATAR,
        overrides: {
            name: LEGACY_CHARACTER,
            extensions: {
                luker: { retained: 'legacy', chat_completion_preset: { name: PRESET, preset: INITIAL.chat_completion_preset.presets[0].preset } },
                card_app: { enabled: true, entry: 'index.js', files: { 'index.js': ENTRY } },
            },
        },
    });
    for (const dirName of ['bound-extension-watch', 'legacy-bound-watch']) {
        const dir = resolve(server.dataRoot, 'default-user', 'card-apps', dirName);
        mkdirSync(dir, { recursive: true });
        writeFileSync(resolve(dir, 'index.js'), ENTRY);
    }
});

async function reselectBoundCharacter(page) {
    await selectCharacterByName(page, OTHER_CHARACTER);
    await expect(page.locator('#character_name_pole')).toHaveValue(OTHER_CHARACTER);
    await selectCharacterByName(page, NAME);
    await expect(page.locator('#character_name_pole')).toHaveValue(NAME);
    await expect(page.locator('#bound-save')).toBeVisible();
    await expect(page.locator('#settings_preset_openai option:checked')).toHaveAttribute('data-luker-char-bound', '1');
}

async function open(page) {
    await awaitMainUI(page, server.baseURL);
    await expect.poll(() => page.evaluate(() => performance.getEntriesByName('[init] complete').some(entry => entry.entryType === 'mark'))).toBe(true);
    await selectCharacterByName(page, NAME);
    await expect(page.locator('#character_name_pole')).toHaveValue(NAME);
    await expect(page.locator('#bound-save')).toBeVisible();
    await page.locator('#bound-reset').click();
    await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    if (existsSync(globalPresetPath())) {
        await page.locator('#bound-delete').click();
        await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    }
    await reselectBoundCharacter(page);
    baseline = disk();
}

async function completeState(page) {
    return page.evaluate(avatar => {
        const c = window.Luker.getContext().characters.find(c => c.avatar === avatar);
        return {
            live: c.data.extensions.luker,
            json: JSON.parse(c.json_data).data.extensions.luker,
            editor: JSON.parse(document.querySelector('#character_json_data').value).data.extensions.luker,
        };
    }, AVATAR);
}

function changed(extra) {
    const expected = structuredClone(baseline);
    expected.chat_completion_preset.presets[0].preset.extensions.watch = extra;
    return expected;
}

async function holdEndpointResponse(page, scope, endpoint, matches = () => true) {
    const patterns = endpoint === '/api/settings/*'
        ? [
            { urlPattern: '*/api/settings/save', requestStage: 'Response' },
            { urlPattern: '*/api/settings/patch', requestStage: 'Response' },
        ]
        : [{ urlPattern: '*' + endpoint, requestStage: 'Response' }];
    const observer = await observeOperations({
        page,
        scope,
        patterns,
        readStored: () => ({ card: disk(), settings: storedSettings() }),
    });
    const held = observer.hold(`endpoint-${endpoint}`, ({ response, event }) => (
        response
        && event.request.method === 'POST'
        && matches(event.request, event.responseStatusCode)
    ));
    return { observer, paused: held.paused() };
}

async function preparePaths(page) {
    await open(page);
    await page.locator('#bound-seed-paths').click();
    await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    await reselectBoundCharacter(page);
    await expect.poll(() => page.evaluate(() => window.Luker.getContext().chatCompletionSettings.extensions.items)).toEqual([{ enabled: false, retained: true }]);
    baseline = disk();
}

async function holdPathSave(page, scope) {
    const marker = randomUUID();
    await page.locator('#bound-value').fill(marker);
    return holdEndpointResponse(page, scope, '/api/settings/*', (request, status) => {
        const body = JSON.parse(request.postData);
        return status === 200 && (
            body.extension_settings?.boundPathAttempt === marker
            || body.operations?.some(op => ['add', 'replace'].includes(op.op) && op.path === '/extension_settings/boundPathAttempt' && op.value === marker)
        );
    });
}

test('public extension save persists the bound card slot without creating a global preset', async ({ page }) => {
    await open(page);
    const presets = [];
    page.on('request', r => { if (r.url().endsWith('/api/presets/save')) presets.push(r.postDataJSON()); });
    await page.locator('#bound-value').fill('dusk');
    await page.locator('#bound-save').click();
    await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    const expected = changed({ value: { bell: 'dusk' } });
    expect(disk()).toEqual(expected);
    expect(await completeState(page)).toEqual({ live: expected, json: expected, editor: expected });
    expect(presets).toEqual([]);
    expect(storedSettings().oai_settings.extensions.watch).toEqual({ value: { bell: 'dusk' } });
});

for (const action of ['save-live', 'save-native']) {
    test(`delayed live preset save cannot publish into another character with the same preset name: ${action}`, async ({ page, resources }) => {
        await open(page);
        const { observer, paused } = await holdEndpointResponse(page, resources, '/api/characters/merge-attributes', (request) => {
            const body = JSON.parse(request.postData);
            return body.avatar === AVATAR && body.data.extensions.luker?.chat_completion_preset?.presets[0]?.preset.temperature === 0.61;
        });
        try {
            await page.locator('#bound-' + action).click();
            const response = await paused;
            expect(disk().chat_completion_preset.presets[0].preset.temperature).toBe(0.61);

            await selectCharacterByName(page, SAME_NAME_CHARACTER);
            await expect(page.locator('#character_name_pole')).toHaveValue(SAME_NAME_CHARACTER);
            const otherBefore = readFileSync(cardPath(SAME_NAME_AVATAR));
            const readRuntime = () => page.evaluate(() => {
                const ctx = window.Luker.getContext();
                const pm = ctx.getPresetManager('openai');
                return { settings: ctx.chatCompletionSettings, body: pm.getPresetList().presets[Number(pm.getSelectedPreset())] };
            });
            const before = await readRuntime();
            expect(before.body.temperature).toBe(0.79);

            await observer.release(response);
            await observer.close();
            expect(await readRuntime()).toEqual(before);
            expect(readFileSync(cardPath(SAME_NAME_AVATAR))).toEqual(otherBefore);
            expect(disk().chat_completion_preset.presets[0].preset.temperature).toBe(0.61);
        } finally {
            await observer.close();
        }
    });
}

test('live preset save retains invocation-time body through delayed acknowledgement', async ({ page, resources }) => {
    await open(page);
    const { observer, paused } = await holdEndpointResponse(page, resources, '/api/characters/merge-attributes', (request) => {
        const body = JSON.parse(request.postData);
        return body.avatar === AVATAR && body.data.extensions.luker?.chat_completion_preset?.presets[0]?.preset.temperature === 0.61;
    });
    try {
        await page.locator('#bound-save-live').click();
        const response = await paused;
        await page.locator('#bound-mutate-live').click();
        await observer.release(response);
        await observer.close();
        expect(disk().chat_completion_preset.presets[0].preset.temperature).toBe(0.61);
        expect(disk().chat_completion_preset.presets[0].preset.extensions.watch.value).toBe('dusk');
        expect(storedSettings().oai_settings.temp_openai).toBe(0.61);
    } finally {
        await observer.close();
    }
});

test('settings failure stops dependent preset and card writes and preserves retry', async ({ page }) => {
    await open(page);
    const before = readFileSync(cardPath());
    const settings = storedSettings();
    const later = [];
    page.on('request', r => { if (/\/api\/(presets\/save|characters\/merge-attributes)$/.test(r.url())) later.push(r.url()); });
    const userDir = resolve(server.dataRoot, 'default-user');
    chmodSync(userDir, 0o555);
    try {
        await page.locator('#bound-value').fill('failed');
        await page.locator('#bound-save').click();
        await expect(page.locator('#bound-result')).toContainText('"ok":false');
        expect(later).toEqual([]);
        expect(readFileSync(cardPath())).toEqual(before);
        expect(storedSettings()).toEqual(settings);
        expect(await completeState(page)).toEqual({ live: baseline, json: baseline, editor: baseline });
    } finally {
        chmodSync(userDir, 0o755);
    }
    await page.locator('#bound-save').click();
    await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    expect(disk()).toEqual(changed({ value: { bell: 'failed' } }));
});

test('secondary card HTTP failure rejects after settings acknowledgement and retry retains siblings', async ({ page }) => {
    await open(page);
    const bytes = readFileSync(cardPath());
    const held = cardPath() + '.held';
    renameSync(cardPath(), held);
    try {
        await page.locator('#bound-value').fill('midnight');
        await page.locator('#bound-save').click();
        await expect(page.locator('#bound-result')).toContainText('"ok":false');
        expect(readFileSync(held)).toEqual(bytes);
        expect(await completeState(page)).toEqual({ live: baseline, json: baseline, editor: baseline });
        expect(storedSettings().oai_settings.extensions.watch).toEqual({ value: { bell: 'midnight' } });
    } finally {
        renameSync(held, cardPath());
    }
    await page.locator('#bound-save').click();
    await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    expect(disk()).toEqual(changed({ value: { bell: 'midnight' } }));
});

for (const withGlobal of [false, true]) {
    test(`queued concurrent extension field writes compose cleanly (global=${withGlobal})`, async ({ page }) => {
        await open(page);
        if (withGlobal) {
            await page.locator('#bound-global').click();
            await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
            await reselectBoundCharacter(page);
        }
        await page.locator('#bound-siblings').click();
        await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
        const expected = changed({ first: 'dawn', second: 'noon' });
        expect(disk()).toEqual(expected);
        expect(await completeState(page)).toEqual({ live: expected, json: expected, editor: expected });
        if (withGlobal) {
            expect(JSON.parse(readFileSync(globalPresetPath(), 'utf8'))).toEqual({
                temperature: 0.91,
                extensions: { globalSibling: true, watch: { first: 'dawn', second: 'noon' } },
            });
        }
    });
}

test('nested preset intent stays isolated from caller and live mutations and normalizes JSON-wire values', async ({ page, resources }) => {
    await open(page);
    await page.locator('#bound-nested-seed').click();
    await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    baseline = disk();

    const { observer, paused } = await holdEndpointResponse(page, resources, '/api/settings/*');
    try {
        await page.locator('#bound-nested-isolate').click();
        const response = await paused;
        await observer.release(response);
        await observer.close();
        await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    } finally {
        await observer.close();
    }

    const intended = { branch: { kept: 'intent', nan: null }, list: [{ kept: 'intent' }, null, null, null] };
    expect(disk().chat_completion_preset.presets[0].preset.extensions.watch.nested).toEqual(intended);
    expect(storedSettings().oai_settings.extensions.watch.nested).toEqual(intended);

    // Unsupported values reject without mutating persisted state; undefined omits field.
    const WIRE_VALUE = { retained: 'wire', nan: null, infinite: null, items: [null, null, null, { retained: true }] };
    await page.locator('#bound-wire-object').click();
    await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    expect(disk().chat_completion_preset.presets[0].preset.extensions.watch.wire).toEqual(WIRE_VALUE);

    await page.locator('#bound-wire-delete').click();
    await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    expect(disk().chat_completion_preset.presets[0].preset.extensions.watch.wire).toBeUndefined();

    const beforeUnsupported = disk();
    await page.locator('#bound-wire-unsupported').click();
    await expect(page.locator('#bound-result')).toContainText('"ok":false');
    await expect(page.locator('#bound-result')).toContainText('could not be cloned');
    expect(disk()).toEqual(beforeUnsupported);
});

test('captured value and path survive consumer mutation while settings waits', async ({ page, resources }) => {
    await open(page);
    const { observer, paused } = await holdEndpointResponse(page, resources, '/api/settings/*');
    try {
        await page.locator('#bound-value').fill('captured');
        await page.locator('#bound-capture').click();
        const response = await paused;
        expect(response.responseStatusCode).toBe(200);
        await observer.release(response);
        await observer.close();
        await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
        const expected = changed({ captured: { bell: 'captured' } });
        expect(disk()).toEqual(expected);
        expect(await completeState(page)).toEqual({ live: expected, json: expected, editor: expected });
    } finally {
        await observer.close();
    }
});

test('binding change during settings acknowledgement refuses stale secondary mutation', async ({ page, resources }) => {
    await open(page);
    const { observer, paused } = await holdEndpointResponse(page, resources, '/api/settings/*');
    try {
        await page.locator('#bound-value').fill('stale');
        await page.locator('#bound-save').click();
        const response = await paused;
        await page.locator('#bound-binding').click();
        await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
        await observer.release(response);
        await observer.close();
        await expect(page.locator('#bound-result')).toContainText('"ok":false');
        const expected = structuredClone(baseline);
        expected.chat_completion_preset.defaultPresetName = 'Other Watch';
        expect(disk()).toEqual(expected);
        expect(await completeState(page)).toEqual({ live: expected, json: expected, editor: expected });
        expect(storedSettings().oai_settings.extensions.watch).toEqual({ value: { bell: 'stale' } });
    } finally {
        await observer.close();
    }
});

test('selection change during settings acknowledgement writes only the captured card and retains namespace edits', async ({ page, resources }) => {
    await open(page);
    const otherPath = cardPath('other-bound-watch.png');
    const other = readFileSync(otherPath);
    const { observer, paused } = await holdEndpointResponse(page, resources, '/api/settings/*');
    try {
        await page.locator('#bound-value').fill('original');
        await page.locator('#bound-save').click();
        const response = await paused;
        await page.locator('#bound-namespace').click();
        await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
        await selectCharacterByName(page, OTHER_CHARACTER);
        await expect(page.locator('#character_name_pole')).toHaveValue(OTHER_CHARACTER);
        await observer.release(response);
        await observer.close();
        const expected = { ...changed({ value: { bell: 'original' } }), laterSibling: 'retained' };
        await expect.poll(disk).toEqual(expected);
        expect(readFileSync(otherPath)).toEqual(other);
        const state = await page.evaluate(avatar => {
            const c = window.Luker.getContext().characters.find(c => c.avatar === avatar);
            return {
                live: c.data.extensions.luker,
                json: JSON.parse(c.json_data).data.extensions.luker,
                editor: JSON.parse(document.querySelector('#character_json_data').value).data.name,
            };
        }, AVATAR);
        expect(state).toEqual({ live: expected, json: expected, editor: OTHER_CHARACTER });
    } finally {
        await observer.close();
    }
});

test('card transport failure preserves acknowledged settings without false success', async ({ page, context, resources }) => {
    await open(page);
    const before = readFileSync(cardPath());
    const { observer, paused } = await holdEndpointResponse(page, resources, '/api/settings/*');
    try {
        await page.locator('#bound-value').fill('offline');
        await page.locator('#bound-save').click();
        const response = await paused;
        await context.setOffline(true);
        await observer.release(response);
        await observer.close();
        await expect(page.locator('#bound-result')).toContainText('"ok":false');
        expect(readFileSync(cardPath())).toEqual(before);
        expect(await completeState(page)).toEqual({ live: baseline, json: baseline, editor: baseline });
        expect(storedSettings().oai_settings.extensions.watch).toEqual({ value: { bell: 'offline' } });
    } finally {
        await context.setOffline(false);
        await observer.close();
    }
    await reselectBoundCharacter(page);
    baseline = disk();
    await page.locator('#bound-value').fill('offline');
    await page.locator('#bound-save').click();
    await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    expect(disk()).toEqual(changed({ value: { bell: 'offline' } }));
});

test('global preset failure prevents card write and preserves cached body until retry', async ({ page }) => {
    await open(page);
    await page.locator('#bound-global').click();
    await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    await reselectBoundCharacter(page);
    const before = readFileSync(cardPath());
    const dir = resolve(server.dataRoot, 'default-user', 'OpenAI Settings');
    const presetPath = globalPresetPath();
    expect(existsSync(presetPath)).toBe(true);
    const presetBytes = readFileSync(presetPath);
    chmodSync(dir, 0o555);
    try {
        await page.locator('#bound-value').fill('failed-preset');
        await page.locator('#bound-save').click();
        await expect(page.locator('#bound-result')).toContainText('"ok":false');
        expect(readFileSync(cardPath())).toEqual(before);
        expect(readFileSync(presetPath)).toEqual(presetBytes);
    } finally {
        chmodSync(dir, 0o755);
    }
    await page.locator('#bound-save').click();
    await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    expect(JSON.parse(readFileSync(presetPath, 'utf8')).extensions).toEqual({ globalSibling: true, watch: { value: { bell: 'failed-preset' } } });
    expect(disk()).toEqual(changed({ value: { bell: 'failed-preset' } }));
});

test('global acknowledgement remains stored when secondary card fails and context consumer retries cleanly', async ({ page }) => {
    await open(page);
    await page.locator('#bound-global').click();
    await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    await reselectBoundCharacter(page);
    const before = readFileSync(cardPath());
    const held = cardPath() + '.held';
    renameSync(cardPath(), held);
    try {
        await page.locator('#bound-value').fill('partial');
        await page.locator('#bound-context').click();
        await expect(page.locator('#bound-result')).toContainText('"ok":false');
        expect(JSON.parse(readFileSync(globalPresetPath(), 'utf8'))).toEqual({
            temperature: 0.91,
            extensions: { globalSibling: true, watch: { value: { bell: 'partial' } } },
        });
        expect(storedSettings().oai_settings.extensions.watch).toEqual({ value: { bell: 'partial' } });
        expect(readFileSync(held)).toEqual(before);
    } finally {
        renameSync(held, cardPath());
    }
    await page.locator('#bound-context').click();
    await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    expect(disk()).toEqual(changed({ value: { bell: 'partial' } }));
});

test('legacy single binding normalizes before public extension save writes its modern slot', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, LEGACY_CHARACTER);
    await expect(page.locator('#character_name_pole')).toHaveValue(LEGACY_CHARACTER);
    await expect(page.locator('#bound-save')).toBeVisible();
    await expect.poll(() => disk(LEGACY_AVATAR).chat_completion_preset.presets?.map(p => p.name)).toEqual([PRESET]);
    await page.locator('#bound-value').fill('legacy');
    await page.locator('#bound-save').click();
    await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    const saved = disk(LEGACY_AVATAR);
    expect(saved.retained).toBe('legacy');
    expect(saved.chat_completion_preset.defaultPresetName).toBe(PRESET);
    expect(saved.chat_completion_preset.presets[0].preset.extensions.watch).toEqual({ value: { bell: 'legacy' } });
});

test('ghost reads, reselect, and sampler changes stay consistent across saves', async ({ page }) => {
    await open(page);
    await page.locator('#temp_openai').fill('0.61', { force: true });
    await expect.poll(() => page.evaluate(() => window.Luker.getContext().chatCompletionSettings.temp_openai)).toBe(0.61);
    await page.locator('#bound-value').fill('sampler');
    await page.locator('#bound-save').click();
    await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    const expected = changed({ value: { bell: 'sampler' } });
    expected.chat_completion_preset.presets[0].preset.temperature = 0.61;
    expect(disk()).toEqual(expected);
    const body = await page.evaluate(name => window.Luker.getContext().getPresetManager('openai').getCompletionPresetByName(name), PRESET);
    expect(body).toEqual(expected.chat_completion_preset.presets[0].preset);
    const ghost = await page.locator('#settings_preset_openai option:checked').getAttribute('value');
    await page.locator('#settings_preset_openai').selectOption({ label: 'Default' }, { force: true });
    await page.locator('#settings_preset_openai').selectOption(ghost, { force: true });
    await page.locator('#bound-ordinary').click();
    await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    expect(disk()).toEqual(expected);
});

for (const action of ['delete', 'rename', 'replace']) {
    test(`global ${action} while preset response waits refuses stale continuation`, async ({ page, resources }) => {
        await open(page);
        await page.locator('#bound-global').click();
        await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
        await reselectBoundCharacter(page);
        const before = disk();
        const { observer, paused } = await holdEndpointResponse(page, resources, '/api/presets/save');
        try {
            await page.locator('#bound-value').fill('obsolete');
            await page.locator('#bound-save').click();
            const response = await paused;
            await page.locator('#bound-' + action).click();
            await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
            await observer.release(response);
            await observer.close();
            await expect(page.locator('#bound-result')).toContainText('"ok":false');
            expect(disk()).toEqual(before);
        } finally {
            await observer.close();
        }
    });
}

test('held settings save detects source conflicts on competing card updates and supports path semantics', async ({ page, resources }) => {
    await preparePaths(page);

    // 1. Empty array / root replace / bracket & array indexing
    await page.locator('#bound-index-bracket').click();
    await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    expect(disk().chat_completion_preset.presets[0].preset.extensions.items[0].enabled).toBe(true);

    // 2. Competing sampler change during held save -> source conflict
    await open(page);
    await page.locator('#temp_openai').fill('0.61', { force: true });
    await expect.poll(() => page.evaluate(() => window.Luker.getContext().chatCompletionSettings.temp_openai)).toBe(0.61);
    {
        const { observer, paused } = await holdEndpointResponse(page, resources, '/api/settings/*');
        try {
            await page.locator('#bound-value').fill('conflict');
            await page.locator('#bound-save').click();
            const response = await paused;
            await page.locator('#bound-later-sampler').click();
            await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
            await observer.release(response);
            await observer.close();
            await expect(page.locator('#bound-result')).toContainText('"ok":false');
            expect(disk().chat_completion_preset.presets[0].preset.temperature).toBe(0.88);
        } finally {
            await observer.close();
        }
    }

    // 3. Competing array insertion during held indexed write -> source conflict
    await preparePaths(page);
    {
        const { observer, paused } = await holdPathSave(page, resources);
        try {
            await page.locator('#bound-index-array').click();
            const response = await paused;
            await page.locator('#bound-later-items').click();
            await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
            await observer.release(response);
            await observer.close();
            await expect(page.locator('#bound-result')).toContainText('"ok":false');
            await expect(page.locator('#bound-result')).toContainText('source conflict at /extensions/items');
        } finally {
            await observer.close();
        }
    }

    // 4. Competing prompt group array edit during held save -> source conflict, then recovery
    await open(page);
    await page.locator('#bound-pending-groups').click();
    await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    {
        const { observer, paused } = await holdEndpointResponse(page, resources, '/api/settings/*');
        try {
            await page.locator('#bound-value').fill('dusk');
            await page.locator('#bound-save').click();
            const response = await paused;
            await page.locator('#bound-later-groups').click();
            await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
            await observer.release(response);
            await observer.close();
            await expect(page.locator('#bound-result')).toContainText('"ok":false');
            await expect(page.locator('#bound-result')).toContainText('source conflict at /extensions/luker/prompt_layout');
        } finally {
            await observer.close();
        }
    }
    await page.locator('#bound-save').click();
    await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    expect(disk().chat_completion_preset.presets[0].preset.extensions.watch).toEqual({ value: { bell: 'dusk' } });
});

test('prompt group DOM creation and preset regex editor save into the bound card slot', async ({ page }) => {
    await open(page);
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

    const savedSlot = disk().chat_completion_preset.presets[0].preset;
    expect(savedSlot.extensions.luker.prompt_groups.some(g => g.name === 'Watch group')).toBe(true);
    expect(savedSlot.extensions.regex_scripts).toHaveLength(1);
    expect(savedSlot.extensions.regex_scripts[0]).toMatchObject({
        scriptName: 'Watch inscription',
        findRegex: '/dusk/g',
        replaceString: 'midnight',
    });
});
