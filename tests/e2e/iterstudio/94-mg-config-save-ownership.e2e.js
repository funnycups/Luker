import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { read as readPngCard } from '../../../src/character-card-parser.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { awaitMainUI, reloadAndAwait, selectCharacterByName } from '../_lib/page.js';
import { openIterStudio, sendIterPrompt } from '../_lib/ui-iter-studio.js';
import { globalStatePath, normalizeIterStudioSettings, readGlobalWorkbenchBodies, sessionBodyNamespace } from './_helpers.js';

const AVATAR = 'config-source-watch.png';
const NAME = 'Keeper of the Configuration Watch';
const OTHER_AVATAR = 'config-other-watch.png';
const OTHER_NAME = 'Keeper of the Other Configuration Watch';
const ENTRY = `import { persistCharacterAdvancedOverridePatch } from '/scripts/extensions/memory-graph/character-overrides.js';
export function init(ctx) {
    const live = ctx.lukerContext;
    const output = document.createElement('pre'); output.id = 'mg-save-outcome';
    const add = (name, run) => {
        const button = document.createElement('button'); button.id = 'mg-save-' + name; button.textContent = name;
        button.onclick = async () => {
            output.textContent = 'pending';
            try { output.textContent = JSON.stringify({value:await run()}); }
            catch(error) { output.textContent = JSON.stringify({error:error.message}); }
        };
        ctx.container.append(button);
    };
    add('parallel', () => Promise.all([
        persistCharacterAdvancedOverridePatch(live, ${JSON.stringify(AVATAR)}, {set:{extractContextTurns:9}}),
        persistCharacterAdvancedOverridePatch(live, ${JSON.stringify(AVATAR)}, {set:{recallMaxIterations:5}}),
    ]));
    add('single', () => persistCharacterAdvancedOverridePatch(live, ${JSON.stringify(AVATAR)}, {set:{extractContextTurns:9}}));
    ctx.addEventListener(document, 'keydown', async event => {
        if (!event.altKey || !event.shiftKey || event.code !== 'KeyB') return;
        event.preventDefault();
        await live.selectCharacterById(live.characters.findIndex(character => character.avatar === ${JSON.stringify(OTHER_AVATAR)}));
    });
    ctx.container.append(output);
}`;

let server, mock;
const settingsFile = () => resolve(server.dataRoot, 'default-user', 'settings.json');
const cardFile = avatar => resolve(server.dataRoot, 'default-user', 'characters', avatar);
const namespace = avatar => JSON.parse(readPngCard(readFileSync(cardFile(avatar)))).data.extensions.memory_graph;
const storedMemoryBodies = () => readGlobalWorkbenchBodies(server.dataRoot, session => session.ws === 'memory');
const workbench = page => page.locator('.wbench .wb-win');
const proposal = page => workbench(page).locator('.wb-chg').last();

function blockFile(filename) {
    const original = `${filename}.before-fault`;
    renameSync(filename, original);
    mkdirSync(filename);
    return original;
}

async function selectSource(page) {
    await selectCharacterByName(page, NAME);
    await expect(page.locator('#mg-save-single')).toBeVisible();
}

async function stageSettings(page, { autoApply = false, waitForSettle = true } = {}) {
    await openIterStudio(page, 'mg', { autoApply });
    mock.scriptToolCall({ name: 'mg_config_set_fields', arguments: { set: { 'settings.extractContextTurns': 9 } } });
    await sendIterPrompt(page, 'mg', 'Keep nine context turns in this configuration.', { waitForSettle });
}

async function approve(page) {
    await proposal(page).locator('.wb-chg-foot button.is-primary').click();
}

async function switchToOther(page) {
    await page.keyboard.press('Alt+Shift+b');
    await expect.poll(() => page.evaluate(() => {
        const context = window.Luker.getContext();
        return context.characters[context.characterId]?.avatar;
    })).toBe(OTHER_AVATAR);
}

test.beforeEach(async ({ resources }) => {
    mock = await startMockLLM({});
    server = await startServer({ scope: resources, batchKey: 'iterstudio', scenarioId: 'config-save-ownership' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    normalizeIterStudioSettings(server.dataRoot);
    for (const [avatar, name] of [[AVATAR, NAME], [OTHER_AVATAR, OTHER_NAME]]) {
        writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: avatar, overrides: { name, extensions: {
            memory_graph: { retained: 'namespace' },
            card_app: { enabled: true, entry: 'index.js', files: { 'index.js': ENTRY } },
        } } });
        const application = resolve(server.dataRoot, 'default-user', 'card-apps', avatar.replace(/\.png$/, ''));
        mkdirSync(application, { recursive: true });
        writeFileSync(resolve(application, 'index.js'), ENTRY);
    }
});

test.afterEach(async () => { await mock?.stop(); });

test('concurrent sparse configuration writes preserve acknowledged sibling fields', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await selectSource(page);
    await page.locator('#mg-save-parallel').click();
    await expect(page.locator('#mg-save-outcome')).toHaveText('{"value":[true,true]}');
    expect(namespace(AVATAR)).toEqual({ retained: 'namespace', advancedOverride: { extractContextTurns: 9, recallMaxIterations: 5, promptDefaultsInitialized: true } });
});

test('a sparse configuration write returns the actual failed HTTP acknowledgement', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await selectSource(page);
    const before = readFileSync(cardFile(AVATAR));
    const original = blockFile(cardFile(AVATAR));
    await page.locator('#mg-save-single').click();
    await expect(page.locator('#mg-save-outcome')).toHaveText('{"value":false}');
    expect(readFileSync(original)).toEqual(before);
    expect(await page.evaluate(avatar => window.Luker.getContext().characters.find(character => character.avatar === avatar).data.extensions.memory_graph, AVATAR))
        .toEqual({ retained: 'namespace' });
});

test('a refused character configuration commit retains its pending review and reports the failed acknowledgement', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await selectSource(page);
    await stageSettings(page);
    await expect(proposal(page)).toHaveClass(/is-pending/);
    const original = blockFile(cardFile(AVATAR));
    await approve(page);
    await expect(page.locator('.wbench .wb-toast')).toContainText('Not saved:');
    await expect(proposal(page)).toHaveClass(/is-pending/);
    await expect(workbench(page).locator('.wb-chg.is-applied')).toHaveCount(0);
    expect(JSON.parse(readPngCard(readFileSync(original))).data.extensions.memory_graph).toEqual({ retained: 'namespace' });
});

test('a refused global configuration commit preserves the previous runtime value', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    const before = await page.evaluate(() => window.Luker.getContext().extensionSettings.memory_graph.extractContextTurns);
    await stageSettings(page);
    await expect(proposal(page)).toHaveClass(/is-pending/);
    const original = blockFile(settingsFile());
    const storedBefore = readFileSync(original);
    await approve(page);
    await expect(page.locator('.wbench .wb-toast')).toContainText('Not saved:');
    await expect(proposal(page)).toHaveClass(/is-pending/);
    await expect(workbench(page).locator('.wb-chg.is-applied')).toHaveCount(0);
    expect(await page.evaluate(() => window.Luker.getContext().extensionSettings.memory_graph.extractContextTurns)).toBe(before);
    expect(readFileSync(original)).toEqual(storedBefore);
});

test('a delayed automatic configuration approval saves its original character after selection changes', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await selectSource(page);
    const otherBefore = readFileSync(cardFile(OTHER_AVATAR));
    const held = mock.holdNextQueuedRequest();
    try {
        await stageSettings(page, { autoApply: true, waitForSettle: false });
        await held.requested;
        await switchToOther(page);
    } finally {
        held.release();
    }
    await expect.poll(() => namespace(AVATAR).advancedOverride).toEqual({ extractContextTurns: 9, promptDefaultsInitialized: true });
    await expect.poll(() => page.evaluate(async avatar => {
        const ctx = window.Luker.getContext();
        const { sessionBodyNamespace } = await import('/scripts/workbench/model/sessions.js');
        const result = await ctx.getCharacterState(avatar, 'workbench_sessions');
        const states = [];
        for (const session of (result.state?.sessions || [])) {
            const bodyRes = await ctx.getCharacterState(avatar, sessionBodyNamespace(session.id));
            for (const turn of (bodyRes.state?.turns || [])) {
                if (turn.role === 'ai') states.push(turn.state);
            }
        }
        return states;
    }, AVATAR)).toEqual(['applied']);
    expect(readFileSync(cardFile(OTHER_AVATAR))).toEqual(otherBefore);
    await server.restart();
    await reloadAndAwait(page, server.baseURL);
    expect(namespace(AVATAR).advancedOverride).toEqual({ extractContextTurns: 9, promptDefaultsInitialized: true });
    expect(readFileSync(cardFile(OTHER_AVATAR))).toEqual(otherBefore);
});

test('configuration rollback retains the approved character identity after selection changes', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await selectSource(page);
    const before = namespace(AVATAR);
    await stageSettings(page);
    await approve(page);
    await expect(proposal(page)).toHaveClass(/is-applied/);
    const otherBefore = readFileSync(cardFile(OTHER_AVATAR));
    await switchToOther(page);
    await workbench(page).locator('.wb-rail .wb-tab', {
        has: page.locator('.wb-tab-label', { hasText: /^Change history$/ }),
    }).click();
    const history = workbench(page).locator('.wb-hist-item').first();
    await history.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(history).toHaveClass(/is-undone/);
    expect(namespace(AVATAR)).toEqual(before);
    expect(readFileSync(cardFile(OTHER_AVATAR))).toEqual(otherBefore);
    await server.restart();
    await reloadAndAwait(page, server.baseURL);
    expect(namespace(AVATAR)).toEqual(before);
    expect(readFileSync(cardFile(OTHER_AVATAR))).toEqual(otherBefore);
});

test('an unidentified historical configuration proposal cannot write after reload', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await stageSettings(page);
    await expect.poll(() => {
        return storedMemoryBodies().some(session =>
            (session.turns || []).some(turn => turn.state === 'pending' && turn.draft));
    }).toBe(true);
    await server.stop();
    const savedBodies = storedMemoryBodies();
    const targetSession = savedBodies.find(session => (session.turns || []).some(turn => turn.state === 'pending' && turn.draft));
    expect(targetSession).toBeTruthy();
    const pending = targetSession.turns.filter(turn => turn.state === 'pending' && turn.draft);
    expect(pending).toHaveLength(1);
    pending[0].draft.target = { type: 'config' };
    writeFileSync(globalStatePath(server.dataRoot, sessionBodyNamespace(targetSession.id)), JSON.stringify(targetSession));
    await server.restart();
    await reloadAndAwait(page, server.baseURL);
    await openIterStudio(page, 'mg');
    await workbench(page).locator('.wb-sess-item', { hasText: 'Keep nine context turns' }).click();
    await expect(page.locator('.wbench .wb-toast')).toContainText('source');
    await expect(workbench(page).locator('.wb-chg.is-pending')).toHaveCount(0);
    expect(await page.evaluate(() => window.Luker.getContext().extensionSettings.memory_graph.extractContextTurns)).not.toBe(9);
});
