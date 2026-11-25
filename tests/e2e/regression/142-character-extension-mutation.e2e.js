import { test, expect } from '../../harness/playwright.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from '../../harness/server.js';
import { completeOnboarding, selectCharacterByName } from '../_lib/page.js';
import { openMemoryWorkspace } from '../_lib/ui-mg-varops.js';
import { setToggleState } from '../_lib/ui-workbench.js';
import { read as readCard } from '../../../src/character-card-parser.js';

let scratch, server, characterPath;

async function openMgTechnicalSettings(page) {
    const lens = await openMemoryWorkspace(page, { subview: 'settings' });
    const panel = lens.locator('.ml-settings').first();
    const details = panel.locator('[data-settings-section="technical"]').first();
    await details.waitFor({ state: 'visible', timeout: 15_000 });
    if (!(await details.evaluate(el => el.hasAttribute('open')))) {
        await details.locator('summary.ml-settings-summary').first().click();
    }
    return panel;
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    scratch = (await scope.directory('character extension support')).path;
    const data = await scope.directory('character extension data');
    server = await startServer({ scope,
        batchKey: 'regression',
        scenarioId: 'character-extension-mutation',
        data,
        extraConfig: {
            enableUserAccounts: false,
            globalExtensionsPath: join(scratch, 'global-extensions'),
            serverPluginsPath: join(scratch, 'server-plugins'),
        },
    });
});

test.beforeEach(async ({ page }) => {
    await page.goto(server.baseURL);
    await completeOnboarding(page);
    await page.waitForFunction(() => performance.getEntriesByName('[init] complete').length > 0);
    await selectCharacterByName(page, 'Seraphina');
    const avatar = await page.evaluate(() => {
        const context = window.Luker.getContext();
        return context.characters[context.characterId].avatar;
    });
    characterPath = join(server.dataRoot, 'default-user/characters', avatar);
    await openMgTechnicalSettings(page);
});

test.afterAll(async () => {

    scratch = server = null;
});

function storedCard() {
    return JSON.parse(readCard(readFileSync(characterPath)));
}

test('saving a character advanced override persists the queued field mutation', async ({ page }, testInfo) => {
    const before = storedCard();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let panel = page.locator('.wbench .mlens .ml-settings').first();
    const recallMethod = panel.locator('[data-field-key="recallMethod"] select');
    const originalRecallMethod = await recallMethod.inputValue();
    await recallMethod.selectOption('rag');
    const rewriteSwitch = panel.locator('button[data-field-key="ragUseQueryRewrite"][role="switch"]');
    const originalRewriteEnabled = (await rewriteSwitch.getAttribute('aria-checked')) === 'true';
    await setToggleState(rewriteSwitch, true);
    const ragRewriteSystemPrompt = await panel.locator('[data-field-key="ragRewriteSystemPrompt"] textarea').inputValue();
    await setToggleState(rewriteSwitch, originalRewriteEnabled);
    await recallMethod.selectOption(originalRecallMethod);
    panel = await openMgTechnicalSettings(page);
    await panel.locator('[data-field-key="toolCallRetryMax"] input').fill('4');
    const edgeRules = 'Only link facts stated in the dialogue.';
    await panel.locator('[data-field-key="extractEdgeRules"] textarea').fill(edgeRules);
    // Code-default prompts normalize to empty inherited slots. Custom text
    // must instead round-trip byte-for-byte through the queued card write.
    for (const key of ['extractTemplate', 'configIterSystemPrompt', 'graphIterSystemPrompt']) {
        const input = panel.locator(`[data-field-key="${key}"] textarea`);
        await expect(input).not.toHaveValue('');
        const original = await input.inputValue();
        await input.fill(`${original}\n\nCharacter prompt persistence marker: ${key}.`);
    }
    await expect(panel.locator('.ml-settings-dirty-pill')).toBeVisible();
    // Capture text from the editor before saving; the persistence result must
    // not supply its own expected override or its canonical card shape.
    const advancedOverride = {
        updateEvery: 2,
        persistentInjectionMaxSeqDistance: 0,
        llmVisibleRecentMessages: 5,
        recallMaxIterations: 3,
        toolCallRetryMax: 4,
        extractExcludeRecentTurns: 0,
        extractContextTurns: 2,
        recallQueryMessages: 2,
        extractBatchTurns: 2,
        rpmLimit: 0,
        extractMode: 'oneshot',
        extractConcurrent: false,
        extractCrawlMaxRounds: 3,
        extractCrawlCandidateLimit: 40,
        extractCrawlMaxReads: 12,
        extractTemplate: await panel.locator('[data-field-key="extractTemplate"] textarea').inputValue(),
        extractEdgeRules: edgeRules,
        extractCrawlSystemPrompt: await panel.locator('[data-field-key="extractCrawlSystemPrompt"] textarea').inputValue(),
        configIterSystemPrompt: await panel.locator('[data-field-key="configIterSystemPrompt"] textarea').inputValue(),
        graphIterSystemPrompt: await panel.locator('[data-field-key="graphIterSystemPrompt"] textarea').inputValue(),
        recallRouteSystemPrompt: await panel.locator('[data-field-key="recallRouteSystemPrompt"] textarea').inputValue(),
        recallFinalizeSystemPrompt: await panel.locator('[data-field-key="recallFinalizeSystemPrompt"] textarea').inputValue(),
        ragRewriteSystemPrompt,
        extractIncludeWorldInfo: true,
        recallIncludeWorldInfo: true,
        promptDefaultsInitialized: true,
    };
    const canonical = {
        avatar: 'default_Seraphina.png',
        chat: before.chat,
        create_date: before.create_date,
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data: structuredClone(before.data),
    };
    canonical.data.extensions.talkativeness = 0.5;
    canonical.data.character_book.extensions = {};
    const expected = structuredClone(canonical);
    expected.data.extensions.memory_graph = { advancedOverride };
    const stickyBtn = (pattern) => panel.locator('.ml-settings-sticky button').filter({ hasText: pattern }).first();
    await stickyBtn(/^(Save Advanced to Global|保存高级到全局|儲存進階到全域)$/).click();
    await expect(panel.locator('.ml-settings-dirty-pill')).toBeHidden();
    await expect.poll(() => JSON.parse(readFileSync(join(server.dataRoot, 'default-user/settings.json'), 'utf8'))
        .extension_settings.memory_graph.toolCallRetryMax).toBe(4);
    await stickyBtn(/^(Save Advanced to Character|保存高级到当前角色|儲存進階到目前角色)$/).click();
    try {
        await expect.poll(() => storedCard().data.extensions.memory_graph?.advancedOverride?.toolCallRetryMax).toBe(4);
    } finally {
        const path = testInfo.outputPath('character-write-observations.json');
        writeFileSync(path, JSON.stringify({ before, expected, after: storedCard(), errors }, null, 2));
        await testInfo.attach('character-write-observations', {
            path,
            contentType: 'application/json',
        });
    }
    const saved = storedCard();
    expect(saved).toEqual(expected);
    expect(errors).toEqual([]);
    await expect(panel.locator('.ml-settings-dirty-pill')).toBeHidden();
    await expect(panel.locator('.ml-settings-sticky .ml-settings-stats')).toContainText(/Character override|角色覆盖|角色覆寫/);
    await expect(stickyBtn(/^(Clear Character Advanced Override|清除角色高级覆盖|清除角色進階覆寫)$/)).toHaveJSProperty('disabled', false);
    await page.screenshot({ path: testInfo.outputPath('saved-character-override.png') });

    await page.reload();
    await page.waitForFunction(() => performance.getEntriesByName('[init] complete').length > 0);
    await selectCharacterByName(page, 'Seraphina');
    panel = await openMgTechnicalSettings(page);
    await expect(panel.locator('[data-field-key="toolCallRetryMax"] input')).toHaveValue('4');
    for (const key of ['extractTemplate', 'configIterSystemPrompt', 'graphIterSystemPrompt']) {
        await expect(panel.locator(`[data-field-key="${key}"] textarea`)).toHaveValue(advancedOverride[key]);
    }
    expect(storedCard()).toEqual(saved);

    await stickyBtn(/^(Clear Character Advanced Override|清除角色高级覆盖|清除角色進階覆寫)$/).click();
    await expect.poll(() => storedCard().data.extensions.memory_graph).toEqual({});
    const cleared = structuredClone(canonical);
    cleared.data.extensions.memory_graph = {};
    expect(storedCard()).toEqual(cleared);
    writeFileSync(testInfo.outputPath('character-cleared.json'), JSON.stringify(storedCard(), null, 2));
    await page.reload();
    await page.waitForFunction(() => performance.getEntriesByName('[init] complete').length > 0);
    await selectCharacterByName(page, 'Seraphina');
    panel = await openMgTechnicalSettings(page);
    await expect(panel.locator('[data-field-key="toolCallRetryMax"] input')).toHaveValue('4');
    await expect(panel.locator('.ml-settings-sticky .ml-settings-stats')).toHaveText(/^(Global|全局|全域)$/);
    await expect(stickyBtn(/^(Clear Character Advanced Override|清除角色高级覆盖|清除角色進階覆寫)$/)).toHaveJSProperty('disabled', true);
    expect(storedCard()).toEqual(cleared);
    expect(errors).toEqual([]);
});
