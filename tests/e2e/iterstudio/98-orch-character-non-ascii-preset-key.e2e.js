// #98 — Character-scope spec iteration keeps a non-ASCII preset key intact.
//
// REAL USER-GESTURE flow:
//   1. Embed a spec preset library in a character card. Its preset key
//      `瞭望 员` contains CJK characters and a space; the stage, the node
//      and the node's preset reference use the same kind of ids.
//   2. Enable the orchestrator in spec mode through the settings drawer,
//      select the card, open the orchestrator iter-studio. The mock LLM
//      answers round 1 with `luker_orch_set_preset` on that key; later
//      rounds are plain text.
//   3. "Approve all pending" → the card on disk keeps the original key with
//      the new prompt, and the node still references it.
//   4. Click Regenerate on the round-1 assistant message → the card on disk
//      rolls back to the committed stored preset without a
//      "Regenerate aborted" toast, and the turn is re-sent.
//   5. Restart, reload, re-assert disk.

import { test, expect } from '../../harness/playwright.js';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait, selectCharacterByName } from '../_lib/page.js';
import { openIterStudio, sendIterPrompt, applyIterBatch, closeIterStudio, rollbackIterBatch } from '../_lib/ui-iter-studio.js';
import { enableOrchestratorMode, saveOrchDrafts } from '../_lib/ui-orchestrator.js';
import { applyWorkbenchChanges, openOrchWorkspace, selectOrchPreset } from '../_lib/ui-workbench.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';
import { read as readPngCard } from '../../../src/character-card-parser.js';
import { normalizeIterStudioSettings } from './_helpers.js';

let server, mock;

const CARD_NAME = 'Wen of the Bryn Lantern';
const CARD_AVATAR = 'wen-bryn-lantern.png';
const STAGE_ID = '守望 阶段';
const NODE_ID = '瞭望 节点';
const PRESET_KEY = '瞭望 员';
const STORED_PRESET = {
    systemPrompt: 'You keep the lantern lookout log for the Bryn headland, one line per bell.',
    userPromptTemplate: 'Log the next bell of the lantern watch.',
};
const NEW_PROMPT = 'You keep the lantern lookout log for the Bryn headland. Note every ship light and every change of the tide bell.';
const AFTER_APPROVE = 'The lookout now records every ship light against the tide bell.';
const AFTER_REGENERATE = 'Second pass on the lookout log: the bell-by-bell lines already match the lantern watch.';

const CARD_SPEC = {
    stages: [{ id: STAGE_ID, mode: 'serial', nodes: [{ id: NODE_ID, preset: PRESET_KEY, userPromptTemplate: 'Keep the watch in order.' }] }],
    defaultTools: null,
    customTools: [],
    seededDefaultCustomTools: true,
    lorebookFilter: { bookPattern: '^Private$', entryPattern: '^Aside$' },
    skills: { visible: [], deny: ['private-notes'] },
};

const SEEDED_PRESETS = {
    [PRESET_KEY]: STORED_PRESET,
    '瞭望': { systemPrompt: 'Spare lookout.', userPromptTemplate: 'Spare bell.', apiPresetName: '', promptPresetName: '', tools: null, skills: { visible: [], deny: ['private-notes'] } },
    'a b': { systemPrompt: 'Space.', userPromptTemplate: 'Bell.' },
    a_b: { systemPrompt: 'Underscore.', userPromptTemplate: 'Bell.' },
};

// Expected schema is independent of production sanitizer output and disk
// reads. Explicit defaults cover the complete stored profile contract.
function expectedProfile(name, prompt = STORED_PRESET.systemPrompt, spare = 'Spare lookout.') {
    return {
        name,
        spec: {
            ...structuredClone(CARD_SPEC),
            stages: [{ id: STAGE_ID, mode: 'serial', nodes: [{
                id: NODE_ID, preset: PRESET_KEY, type: 'worker', userPromptTemplate: 'Keep the watch in order.', tools: null,
            }] }],
        },
        presets: {
            [PRESET_KEY]: { ...STORED_PRESET, systemPrompt: prompt, apiPresetName: '', promptPresetName: '', tools: null },
            '瞭望': { ...structuredClone(SEEDED_PRESETS['瞭望']), systemPrompt: spare },
            'a b': { ...SEEDED_PRESETS['a b'], apiPresetName: '', promptPresetName: '', tools: null },
            a_b: { ...SEEDED_PRESETS.a_b, apiPresetName: '', promptPresetName: '', tools: null },
        },
    };
}

function readCardSpecEntry(dataRoot) {
    const png = readFileSync(resolve(dataRoot, 'default-user', 'characters', CARD_AVATAR));
    const card = JSON.parse(readPngCard(png));
    const orch = card?.data?.extensions?.orchestrator;
    const activeId = orch?.activePresetIds?.spec || '';
    return activeId ? (orch?.presetLibraries?.spec?.[activeId] || null) : null;
}

function chatRequestCount() {
    return mock.requests.filter(r => String(r.url || '').includes('/chat/completions')).length;
}

async function restoreWatchFields(page, scope) {
    const lens = await openOrchWorkspace(page, 'setup');
    for (const [key, prompt] of [[PRESET_KEY, STORED_PRESET.systemPrompt], ['瞭望', 'Spare lookout.']]) {
        const details = lens.locator(`details.ol-setup-node[data-detail-key="spec-preset:${key}"]`).first();
        if (!(await details.evaluate(el => el.open))) await details.locator('summary').first().click();
        const input = details.locator('textarea.ol-textarea').first();
        await input.fill(prompt);
        await input.press('Tab');
    }
    await saveOrchDrafts(page);
    await openIterStudio(page, 'orch', { scope });
    await closeIterStudio(page);
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope,
        batchKey: 'iterstudio',
        scenarioId: '98-orch-character-non-ascii-preset-key',
        extraConfig: { storage: { mode: 'fs' } },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    normalizeIterStudioSettings(server.dataRoot);
    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: CARD_AVATAR,
        overrides: {
            name: CARD_NAME,
            extensions: {
                orchestrator: {
                    override: { mode: 'spec' },
                    presetLibraries: {
                        spec: {
                            lantern: { name: 'Lantern watch', spec: CARD_SPEC, presets: SEEDED_PRESETS },
                            relief: { name: 'Relief watch', spec: CARD_SPEC, presets: SEEDED_PRESETS },
                            lit: { name: 'Lit watch', spec: CARD_SPEC, presets: { ...SEEDED_PRESETS, [PRESET_KEY]: { ...STORED_PRESET, systemPrompt: NEW_PROMPT } } },
                        },
                        agenda: {},
                        loop: {},
                        director: {},
                    },
                    activePresetIds: { spec: 'lantern', agenda: '', loop: '', director: '' },
                },
            },
        },
    });
    const path = resolve(server.dataRoot, 'default-user', 'settings.json');
    const settings = JSON.parse(readFileSync(path, 'utf8'));
    settings.extension_settings.orchestrator = {
        ...settings.extension_settings.orchestrator,
        presetLibrariesMigrationDone: 1,
        presetLibraries: {
            spec: {
                watch: { name: 'Watch', spec: CARD_SPEC, presets: SEEDED_PRESETS },
                relief: { name: 'Relief watch', spec: CARD_SPEC, presets: SEEDED_PRESETS },
                lit: { name: 'Lit watch', spec: CARD_SPEC, presets: { ...SEEDED_PRESETS, [PRESET_KEY]: { ...STORED_PRESET, systemPrompt: NEW_PROMPT } } },
            },
            agenda: {}, loop: {}, director: {},
        },
        activePresetIds: { spec: 'watch', agenda: '', loop: '', director: '' },
    };
    writeFileSync(path, JSON.stringify(settings));
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#98 — Orchestrator iter-studio character scope keeps a non-ASCII preset key through approve and regenerate', () => {
    test('continuing an earlier pending draft includes a later acknowledged edit', async ({ page }) => {
        const sparePrompt = 'Keep the relief lantern observations beside the tide ledger.';
        mock.scriptCompletion(null);
        await awaitMainUI(page, server.baseURL);
        await enableOrchestratorMode(page, 'spec');
        await selectCharacterByName(page, CARD_NAME);
        const win = await openIterStudio(page, 'orch', { scope: 'character' });
        mock.scriptToolCall({ name: 'luker_orch_set_preset', arguments: { preset_id: PRESET_KEY, systemPrompt: NEW_PROMPT, userPromptTemplate: STORED_PRESET.userPromptTemplate } });
        mock.scriptReply('The main lookout draft is ready.');
        await sendIterPrompt(page, 'orch', 'Revise the main lookout log without applying it.');
        mock.scriptToolCall({ name: 'luker_orch_set_preset', arguments: { preset_id: '瞭望', systemPrompt: sparePrompt, userPromptTemplate: SEEDED_PRESETS['瞭望'].userPromptTemplate } });
        mock.scriptReply('The relief lookout draft is ready.');
        await sendIterPrompt(page, 'orch', 'Revise the relief lookout log separately.');
        await expect(win.locator('.wb-chg.is-pending')).toHaveCount(2);
        await applyWorkbenchChanges(page, { index: 1 });
        await expect.poll(() => readCardSpecEntry(server.dataRoot)).toEqual(expectedProfile('Lantern watch', STORED_PRESET.systemPrompt, sparePrompt));
        mock.scriptToolCall({ name: 'luker_orch_read_spec_fields', arguments: { paths: ['presets'] } });
        mock.scriptReply('The current lookout profiles have been inspected.');
        await sendIterPrompt(page, 'orch', 'Inspect both current lookout profiles.');
        const trace = win.locator('.wb-msg-ai').last().locator('.wb-tool-trace');
        await trace.locator('summary').click();
        await expect(trace).toContainText(NEW_PROMPT);
        await expect(trace).toContainText(sparePrompt);
        await applyWorkbenchChanges(page, { index: 0 });
        const expected = expectedProfile('Lantern watch', NEW_PROMPT, sparePrompt);
        await expect.poll(() => readCardSpecEntry(server.dataRoot)).toEqual(expected);
        await closeIterStudio(page);
        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        expect(readCardSpecEntry(server.dataRoot)).toEqual(expected);
        await selectCharacterByName(page, CARD_NAME);
        await restoreWatchFields(page, 'character');
    });

    for (const scope of ['character', 'global']) {
        const originalId = scope === 'character' ? 'lantern' : 'watch';
        const originalName = scope === 'character' ? 'Lantern watch' : 'Watch';
        const characterName = scope === 'character' ? CARD_NAME : 'Seraphina';
        const readLibrary = () => {
            const orch = scope === 'character'
                ? JSON.parse(readPngCard(readFileSync(resolve(server.dataRoot, 'default-user', 'characters', CARD_AVATAR)))).data.extensions.orchestrator
                : JSON.parse(readFileSync(resolve(server.dataRoot, 'default-user', 'settings.json'), 'utf8')).extension_settings.orchestrator;
            return { presets: orch.presetLibraries.spec, activeId: orch.activePresetIds.spec };
        };
        for (const decision of ['apply', 'undo']) {
            const otherId = decision === 'apply' ? 'relief' : 'lit';
            const expected = expectedProfile(originalName, decision === 'apply' ? NEW_PROMPT : STORED_PRESET.systemPrompt);
            const prepare = decision === 'undo' ? async page => {
                await applyIterBatch(page, 'orch');
                await expect.poll(() => readLibrary().presets[originalId]).toEqual(expectedProfile(originalName, NEW_PROMPT));
            } : async () => {};
            const decide = decision === 'apply' ? applyIterBatch : rollbackIterBatch;
            const cleanup = decision === 'apply' ? restoreWatchFields : async () => {};

            test(`${scope} ${decision} stays bound to its captured preset after native selection changes`, async ({ page }) => {
                mock.scriptCompletion(({ turn }) => turn === 0 ? {
                    tool: 'luker_orch_set_preset',
                    arguments: { preset_id: PRESET_KEY, systemPrompt: NEW_PROMPT, userPromptTemplate: STORED_PRESET.userPromptTemplate },
                } : { text: AFTER_APPROVE });
                await awaitMainUI(page, server.baseURL);
                await enableOrchestratorMode(page, 'spec');
                await selectCharacterByName(page, characterName);
                await selectOrchPreset(page, originalId, { scope });
                await openIterStudio(page, 'orch', { scope });
                await sendIterPrompt(page, 'orch', 'Record every ship light in the lantern lookout log.');
                await prepare(page);
                await selectOrchPreset(page, otherId, { scope });
                await expect.poll(() => readLibrary().activeId).toBe(otherId);
                const otherBefore = readLibrary().presets[otherId];
                await openIterStudio(page, 'orch', { scope });
                await decide(page, 'orch');
                await expect.poll(() => readLibrary().presets[originalId]).toEqual(expected);
                expect(readLibrary().presets[otherId]).toEqual(otherBefore);
                expect(readLibrary().activeId).toBe(otherId);
                await closeIterStudio(page);
                await server.restart();
                await reloadAndAwait(page, server.baseURL);
                expect(readLibrary().presets[originalId]).toEqual(expected);
                expect(readLibrary().presets[otherId]).toEqual(otherBefore);
                expect(readLibrary().activeId).toBe(otherId);
                await selectCharacterByName(page, characterName);
                await selectOrchPreset(page, originalId, { scope });
                await cleanup(page, scope);
            });
        }
    }

    test('approve edits the original key on the card and regenerate rolls it back without conflict', async ({ page }) => {
        mock.scriptCompletion(({ turn }) => {
            if (turn === 0) {
                return {
                    toolCalls: [{
                        name: 'luker_orch_set_preset',
                        arguments: {
                            preset_id: PRESET_KEY,
                            systemPrompt: NEW_PROMPT,
                            userPromptTemplate: STORED_PRESET.userPromptTemplate,
                        },
                    }],
                };
            }
            return { text: turn === 1 ? AFTER_APPROVE : AFTER_REGENERATE };
        });

        expect(readCardSpecEntry(server.dataRoot)?.presets).toEqual(SEEDED_PRESETS);

        await awaitMainUI(page, server.baseURL);
        await enableOrchestratorMode(page, 'spec');
        await expect.poll(() => {
            const orch = JSON.parse(readFileSync(resolve(server.dataRoot, 'default-user', 'settings.json'), 'utf8'))?.extension_settings?.orchestrator;
            return [orch?.enabled, orch?.executionMode];
        }, { timeout: 10_000 }).toEqual([true, 'spec']);
        await selectCharacterByName(page, CARD_NAME);
        await openIterStudio(page, 'orch', { scope: 'character' });
        await sendIterPrompt(page, 'orch', 'Have the lantern lookout note every ship light against the tide bell.');

        const wbWin = page.locator('.wbench .wb-win').first();
        await expect(wbWin.locator('.wb-chg.is-pending .wb-chg-line')).toHaveCount(1);
        await expect(wbWin).toContainText(AFTER_APPROVE, { timeout: 15_000 });
        await applyIterBatch(page, 'orch');

        await expect.poll(() => readCardSpecEntry(server.dataRoot)?.presets?.[PRESET_KEY]?.systemPrompt || '', { timeout: 15_000 }).toBe(NEW_PROMPT);
        expect(readCardSpecEntry(server.dataRoot)).toEqual(expectedProfile('Lantern watch', NEW_PROMPT));
        const storedEntry = expectedProfile('Lantern watch');

        const requestsBeforeRegenerate = chatRequestCount();
        const answerAgain = wbWin.locator('.wb-msg-acts button.wb-msg-act', { hasText: /Answer again|重新回答/i }).last();
        await expect(answerAgain).toBeVisible({ timeout: 10_000 });
        await expect(answerAgain).toBeEnabled({ timeout: 10_000 });
        await answerAgain.click();

        await expect.poll(chatRequestCount, { timeout: 30_000 }).toBeGreaterThan(requestsBeforeRegenerate);
        await expect(wbWin).toContainText(AFTER_REGENERATE, { timeout: 30_000 });
        await expect(page.locator('.wbench .wb-toast.is-error')).toHaveCount(0);
        await expect(page.locator('#toast-container .toast-error')).toHaveCount(0);
        await expect.poll(() => readCardSpecEntry(server.dataRoot)?.presets?.[PRESET_KEY]?.systemPrompt || '', { timeout: 15_000 }).toBe(STORED_PRESET.systemPrompt);
        expect(readCardSpecEntry(server.dataRoot)).toEqual(storedEntry);

        await closeIterStudio(page);
        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        expect(readCardSpecEntry(server.dataRoot)).toEqual(storedEntry);
    });

    test('regenerate stops when reverting the applied card fails', async ({ page }) => {
        mock.scriptCompletion(({ turn }) => turn === 0 ? {
            toolCalls: [{
                name: 'luker_orch_set_preset',
                arguments: {
                    preset_id: PRESET_KEY,
                    systemPrompt: NEW_PROMPT,
                    userPromptTemplate: STORED_PRESET.userPromptTemplate,
                },
            }],
        } : { text: AFTER_APPROVE });
        await awaitMainUI(page, server.baseURL);
        await enableOrchestratorMode(page, 'spec');
        await selectCharacterByName(page, CARD_NAME);
        await openIterStudio(page, 'orch', { scope: 'character' });
        await sendIterPrompt(page, 'orch', 'Update the lantern lookout log.');
        await applyIterBatch(page, 'orch');
        await expect.poll(() => readCardSpecEntry(server.dataRoot)).toEqual(expectedProfile('Lantern watch', NEW_PROMPT));

        const win = page.locator('.wbench .wb-win').first();
        const answerAgain = win.locator('.wb-msg-acts button.wb-msg-act', { hasText: /Answer again|重新回答/i }).last();
        await expect(answerAgain).toBeEnabled({ timeout: 10_000 });
        const cardPath = resolve(server.dataRoot, 'default-user', 'characters', CARD_AVATAR);
        const heldPath = `${cardPath}.held`;
        const approvedBytes = readFileSync(cardPath);
        const before = chatRequestCount();
        renameSync(cardPath, heldPath);
        try {
            await answerAgain.click();
            await expect(page.locator('.wbench .wb-toast.is-error')).toContainText('Could not undo');
            await expect(answerAgain).toBeEnabled({ timeout: 10_000 });
            await expect(win.locator('.wb-chg.is-applied')).toHaveCount(1);
            await expect(win).toContainText(AFTER_APPROVE);
            expect(chatRequestCount()).toBe(before);
            expect(readFileSync(heldPath)).toEqual(approvedBytes);
        } finally {
            renameSync(heldPath, cardPath);
        }
        await rollbackIterBatch(page, 'orch');
        await expect.poll(() => readCardSpecEntry(server.dataRoot)).toEqual(expectedProfile('Lantern watch'));
    });

    test('global spec approve and rollback preserve opaque siblings and disjoint external edits', async ({ page }) => {
        const readGlobal = () => JSON.parse(readFileSync(resolve(server.dataRoot, 'default-user', 'settings.json'), 'utf8')).extension_settings.orchestrator.presetLibraries.spec.watch;
        mock.scriptCompletion(({ turn }) => turn === 0 ? { tool: 'luker_orch_set_preset', arguments: {
            preset_id: PRESET_KEY, systemPrompt: NEW_PROMPT, userPromptTemplate: STORED_PRESET.userPromptTemplate,
        } } : { text: 'The lookout log follows the tide bell.' });
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.locator('#options_button').click();
        await page.locator('#option_close_chat:visible').click();
        await expect.poll(() => page.evaluate(() => window.Luker.getContext().characterId)).toBeUndefined();
        await enableOrchestratorMode(page, 'spec');
        await openIterStudio(page, 'orch', { scope: 'global' });
        await sendIterPrompt(page, 'orch', 'Have the lookout note every ship light against the tide bell.');
        await applyIterBatch(page, 'orch');
        await expect.poll(() => readGlobal().presets[PRESET_KEY].systemPrompt).toBe(NEW_PROMPT);
        expect(readGlobal()).toEqual(expectedProfile('Watch', NEW_PROMPT));
        // A separate real editor changes an untouched path while the proposal
        // remains committed. Reloading is not needed to invoke the target.
        const lens = await openOrchWorkspace(page, 'setup');
        const spareDetails = lens.locator('details.ol-setup-node[data-detail-key="spec-preset:瞭望"]').first();
        await expect(spareDetails).toBeVisible({ timeout: 10_000 });
        if (!(await spareDetails.evaluate(el => el.open))) {
            await spareDetails.locator('summary').first().click();
        }
        const sibling = spareDetails.locator('textarea.ol-textarea').first();
        await sibling.fill('Keep the spare lookout notes.');
        await sibling.press('Tab');
        await saveOrchDrafts(page);
        await expect.poll(() => readGlobal().presets['瞭望'].systemPrompt).toBe('Keep the spare lookout notes.');
        expect(readGlobal()).toEqual(expectedProfile('Watch', NEW_PROMPT, 'Keep the spare lookout notes.'));
        await openIterStudio(page, 'orch', { scope: 'global' });
        const sessItem = page.locator('.wbench aside.wb-sess .wb-sess-item').first();
        if (await sessItem.count() > 0 && !(await sessItem.evaluate(el => el.classList.contains('is-active')))) {
            await sessItem.click();
        }
        await rollbackIterBatch(page, 'orch');
        await expect.poll(() => readGlobal().presets[PRESET_KEY].systemPrompt).toBe(STORED_PRESET.systemPrompt);
        expect(readGlobal()).toEqual(expectedProfile('Watch', STORED_PRESET.systemPrompt, 'Keep the spare lookout notes.'));
        await closeIterStudio(page);
    });
});
