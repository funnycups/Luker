// tests/e2e/workbench/02-ai-iteration-apply-undo-all-targets.e2e.js
//
// End-to-end mockLLM AI iteration + Apply + Undo across all 5 Workbench targets:
//   1. `card`   (v2 system_prompt & alternate_greetings + live-draft lorebook_* reads)
//   2. `preset` (empty prompt_order: [] initialization + prompt entry add/enable)
//   3. `world`  (world book entry edit + undo)
//   4. `memory` (character scope reset controls, lorebook reads, advanced schema fields)
//   5. `orch`   (spec mode string-shorthand node tools + skills upgrade, apply & undo)

import { test, expect } from '../../harness/playwright.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import {
    bootstrapCustomBackend,
    appendConnectionProfile,
    markOnboarded,
    writePreset,
} from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { disableTagImportPopup, writeEmbeddedCharacter } from '../character/_helpers.js';
import { normalizeIterStudioSettings, selectPresetByName } from '../preset/_helpers.js';
import {
    applyIterateChanges,
    closeWorkbench,
    openChangeHistory,
    openWorkbenchIterate,
    sendIteratePrompt,
    undoIterateChanges,
    undoLatestHistoryEntry,
    workbenchWindow,
} from '../_lib/ui-workbench.js';

let server, mock;

const ASH_AVATAR = 'ash-the-cartographer.png';
const ASH_NAME = 'Ash the Cartographer';
const BOOK_NAME = 'Eldoria';
const EMPTY_ORDER_PRESET = 'EmptyOrderPreset';

function settingsJsonPath(dataRoot) {
    return resolve(dataRoot, 'default-user', 'settings.json');
}

function readWorldBook(dataRoot, bookName = BOOK_NAME) {
    return JSON.parse(readFileSync(resolve(dataRoot, 'default-user', 'worlds', `${bookName}.json`), 'utf8'));
}

function readPresetFile(dataRoot, name) {
    return JSON.parse(readFileSync(resolve(dataRoot, 'default-user', 'OpenAI Settings', `${name}.json`), 'utf8'));
}

function readActiveSpecPreset(dataRoot) {
    const s = JSON.parse(readFileSync(settingsJsonPath(dataRoot), 'utf8'));
    const ext = s?.extension_settings?.orchestrator;
    const activeId = ext?.activePresetIds?.spec || '';
    return activeId ? (ext?.presetLibraries?.spec?.[activeId] || null) : null;
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({
        scope,
        batchKey: 'workbench',
        scenarioId: '02-ai-iteration-all-targets',
        extraConfig: { storage: { mode: 'fs' } },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    normalizeIterStudioSettings(server.dataRoot);
    disableTagImportPopup({ dataRoot: server.dataRoot });

    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: ASH_AVATAR,
        overrides: {
            extensions: { world: BOOK_NAME },
        },
    });

    writePreset({
        dataRoot: server.dataRoot,
        name: EMPTY_ORDER_PRESET,
        overrides: {
            temperature: 0.75,
            prompts: [
                { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'Be helpful and stay in character.' },
            ],
            prompt_order: [],
        },
    });

    // Enable orchestrator in spec mode with default string-shorthand stages.
    const sp = settingsJsonPath(server.dataRoot);
    const s = JSON.parse(readFileSync(sp, 'utf8'));
    s.extension_settings = s.extension_settings || {};
    s.extension_settings.orchestrator = {
        ...(s.extension_settings.orchestrator || {}),
        enabled: true,
        executionMode: 'spec',
    };
    writeFileSync(sp, JSON.stringify(s, null, 4));
});

test.afterAll(async () => {
    await mock?.stop();
});

test.describe('Workbench AI iteration + Apply + Undo across all 5 targets', () => {
    test.setTimeout(240_000);

    test('card: edits v2 system_prompt/alternate_greetings, reads live-draft lorebook_get, applies and undoes', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        const beforeBookContent = readWorldBook(server.dataRoot)?.entries?.['0']?.content || '';
        const newSystemPrompt = 'Stay grounded in Bryn headland lore; never break narrative voice.';
        const newGreetings = [
            '*Seraphina taps the brass compass twice.* "The wind turned early."',
            '*She holds the chart toward the lantern.* "Look at the southern reef."',
        ];
        const draftLorebookContent = `${beforeBookContent}\nDraft lantern marker at the north pier.`;

        const beforeCount = mock.requests.length;
        mock.scriptCompletion((req) => {
            if (req.turn === 0) {
                return {
                    toolCalls: [
                        { name: 'cea_set_card_field', arguments: { field: 'system_prompt', value: newSystemPrompt } },
                        { name: 'cea_set_card_field', arguments: { field: 'alternate_greetings', value: newGreetings } },
                        { name: 'cea_update_lorebook_entry', arguments: { book_name: BOOK_NAME, uid: 0, patch: { content: draftLorebookContent } } },
                    ],
                };
            }
            if (req.turn === 1) {
                return {
                    toolCalls: [
                        { name: 'lorebook_get', arguments: { book_name: BOOK_NAME, uids: [0] } },
                    ],
                };
            }
            return { text: 'Updated v2 card fields and Eldoria entry 0.' };
        });

        await openWorkbenchIterate(page, 'card');
        await sendIteratePrompt(page, 'Update v2 system_prompt, alternate_greetings, and Eldoria entry 0.');
        mock.clearScriptedCompletion();

        // Confirm live-draft lorebook_get returned the staged edit BEFORE Apply.
        const cardReqs = mock.requests.slice(beforeCount).filter((r) => String(r.url || '').includes('chat/completions'));
        const lastToolMsgs = (cardReqs[cardReqs.length - 1]?.body?.messages || []).filter((m) => m?.role === 'tool');
        expect(lastToolMsgs.some((m) => String(m.content || '').includes('Draft lantern marker at the north pier.'))).toBe(true);

        await applyIterateChanges(page);

        const avatar = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return ctx.characters?.[ctx.characterId]?.avatar || '';
        });
        const cardAfterApply = await page.evaluate(async (av) => {
            const ctx = window.Luker.getContext();
            const res = await fetch('/api/characters/get', {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify({ avatar_url: av }),
            });
            return res.json();
        }, avatar);
        expect(cardAfterApply?.data?.system_prompt).toBe(newSystemPrompt);
        expect(cardAfterApply?.data?.alternate_greetings).toEqual(newGreetings);
        expect(readWorldBook(server.dataRoot)?.entries?.['0']?.content).toBe(draftLorebookContent);

        // Undo via Change history and confirm disk reverts.
        await openChangeHistory(page, { filter: /^(Character card|角色卡)$/ });
        await undoLatestHistoryEntry(page);

        await expect.poll(() => readWorldBook(server.dataRoot)?.entries?.['0']?.content || '', { timeout: 10_000 })
            .toBe(beforeBookContent);
        const cardAfterUndo = await page.evaluate(async (av) => {
            const ctx = window.Luker.getContext();
            const res = await fetch('/api/characters/get', {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify({ avatar_url: av }),
            });
            return res.json();
        }, avatar);
        expect(cardAfterUndo?.data?.system_prompt).not.toBe(newSystemPrompt);
        await closeWorkbench(page);
    });

    test('preset: applies a new prompt entry to the live preset and undoes it', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectPresetByName(page, EMPTY_ORDER_PRESET);

        mock.scriptCompletion((req) => {
            if (req.turn === 0) {
                return {
                    toolCalls: [
                        {
                            name: 'preset_upsert_prompt_entry',
                            arguments: {
                                identifier: 'custom_rule',
                                name: 'Custom Rule',
                                role: 'system',
                                content: 'Keep dialogue grounded.',
                                enabled: true,
                                position: 1,
                            },
                        },
                        {
                            name: 'preset_upsert_prompt_order_item',
                            arguments: {
                                character_id: '100001',
                                identifier: 'main',
                                position: 1,
                                enabled: true,
                            },
                        },
                    ],
                };
            }
            return { text: 'Added custom_rule and initialized prompt_order.' };
        });

        await openWorkbenchIterate(page, 'preset');
        await sendIteratePrompt(page, 'Add custom_rule and enable main in prompt_order.');
        mock.clearScriptedCompletion();

        await applyIterateChanges(page);

        await expect.poll(() => {
            const order = readPresetFile(server.dataRoot, EMPTY_ORDER_PRESET)?.prompt_order?.[0]?.order || [];
            const ids = order.map((o) => o.identifier);
            return ids.includes('main') && ids.includes('custom_rule');
        }, { timeout: 10_000 }).toBe(true);
        const appliedPreset = readPresetFile(server.dataRoot, EMPTY_ORDER_PRESET);
        expect(appliedPreset.prompts.find((p) => p.identifier === 'custom_rule')?.content).toBe('Keep dialogue grounded.');

        await undoIterateChanges(page);
        await expect.poll(() => {
            const p = readPresetFile(server.dataRoot, EMPTY_ORDER_PRESET);
            const ids = (p?.prompt_order?.[0]?.order || []).map((o) => o.identifier);
            return p.prompts.some((x) => x.identifier === 'custom_rule') || ids.includes('custom_rule');
        }, { timeout: 10_000 }).toBe(false);
        await closeWorkbench(page);
    });

    test('world: edits character-bound world book entry, applies, and undoes', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        const beforeContent = readWorldBook(server.dataRoot)?.entries?.['0']?.content || '';
        const appended = `${beforeContent}\nSignal bell tolls twice at dusk.`;

        mock.scriptCompletion((req) => {
            if (req.turn === 0) {
                return {
                    toolCalls: [{
                        name: 'cea_update_lorebook_entry',
                        arguments: { book_name: BOOK_NAME, uid: 0, patch: { content: appended } },
                    }],
                };
            }
            return { text: 'Updated Eldoria entry 0.' };
        });

        await openWorkbenchIterate(page, 'world', { scope: 'character' });
        await sendIteratePrompt(page, 'Append the dusk signal bell note to Eldoria entry 0.');
        mock.clearScriptedCompletion();

        await applyIterateChanges(page);
        await expect.poll(() => readWorldBook(server.dataRoot)?.entries?.['0']?.content || '', { timeout: 10_000 })
            .toBe(appended);

        await undoIterateChanges(page);
        await expect.poll(() => readWorldBook(server.dataRoot)?.entries?.['0']?.content || '', { timeout: 10_000 })
            .toBe(beforeContent);
        await closeWorkbench(page);
    });

    test('memory: exercises reset controls, lorebook reads, and advanced schema fields with Apply + Undo', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, ASH_NAME);

        await openWorkbenchIterate(page, 'memory', { scope: 'character' });
        const win = workbenchWindow(page);

        // Exercise reset-blank / reset-global controls on character scope.
        const resetBlankBtn = win.locator('[data-wb-memory-control="reset-blank"]').first();
        const resetGlobalBtn = win.locator('[data-wb-memory-control="reset-global"]').first();
        await expect(resetBlankBtn).toBeVisible();
        await expect(resetGlobalBtn).toBeDisabled();
        await resetBlankBtn.click();
        await expect(resetBlankBtn).toHaveAttribute('aria-pressed', 'true');
        await expect(resetGlobalBtn).toBeEnabled();
        await resetGlobalBtn.click();
        await expect(resetBlankBtn).toHaveAttribute('aria-pressed', 'false');

        const beforeCount = mock.requests.length;
        mock.scriptCompletion((req) => {
            if (req.turn === 0) {
                return {
                    toolCalls: [
                        { name: 'world_book_list', arguments: {} },
                        { name: 'lorebook_list', arguments: { book_name: BOOK_NAME } },
                        { name: 'lorebook_get', arguments: { book_name: BOOK_NAME, uids: [0] } },
                    ],
                };
            }
            if (req.turn === 1) {
                return {
                    toolCalls: [{
                        name: 'mg_schema_set_node_type',
                        arguments: {
                            node_type: {
                                id: 'tide_ledger',
                                label: 'Tide Ledger',
                                tableName: 'tide_ledger_table',
                                tableColumns: ['harbor', 'tide_height', 'notes'],
                                embeddingColumns: ['harbor', 'notes'],
                                requiredColumns: ['harbor'],
                                primaryKeyColumns: ['harbor'],
                                forceUpdate: true,
                                editable: true,
                                extractEveryN: 3,
                                keywords: ['tide', 'harbor'],
                                columnHints: { harbor: 'Harbor name', tide_height: 'Measured tide stage' },
                                compression: {
                                    mode: 'hierarchical',
                                    threshold: 4,
                                    fanIn: 2,
                                    maxDepth: 5,
                                    keepRecentLeaves: 1,
                                    summarizeInstruction: 'Keep tide extremes.',
                                },
                            },
                        },
                    }],
                };
            }
            return { text: 'Added tide_ledger with advanced schema fields after reading bound lorebook.' };
        });

        await sendIteratePrompt(page, 'Check bound lorebooks and add an advanced tide_ledger memory type.');
        mock.clearScriptedCompletion();

        // Confirm lorebook reads reached the model in character scope.
        const memReqs = mock.requests.slice(beforeCount).filter((r) => String(r.url || '').includes('chat/completions'));
        const toolResults = (memReqs[1]?.body?.messages || []).filter((m) => m?.role === 'tool').map((m) => String(m.content || ''));
        expect(toolResults.some((t) => t.includes(BOOK_NAME))).toBe(true);

        await applyIterateChanges(page);

        await expect.poll(async () => {
            return await page.evaluate(() => {
                const ctx = window.Luker.getContext();
                const ch = ctx.characters?.[ctx.characterId];
                return ch?.data?.extensions?.memory_graph?.schemaOverride || null;
            });
        }, { timeout: 10_000 }).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'tide_ledger',
                primaryKeyColumns: ['harbor'],
                forceUpdate: true,
                editable: true,
                extractEveryN: 3,
                compression: expect.objectContaining({
                    mode: 'hierarchical',
                    threshold: 4,
                    fanIn: 2,
                    maxDepth: 5,
                    keepRecentLeaves: 1,
                    summarizeInstruction: 'Keep tide extremes.',
                }),
            }),
        ]));

        await undoIterateChanges(page);
        await expect.poll(async () => {
            return await page.evaluate(async () => {
                const ctx = window.Luker.getContext();
                const mg = ctx.getExtensionApi('memory-graph');
                const info = mg.getSchemaScopeInfo(ctx);
                const avatar = ctx.characters?.[ctx.characterId]?.avatar || '';
                const res = await fetch('/api/characters/get', {
                    method: 'POST',
                    headers: ctx.getRequestHeaders(),
                    body: JSON.stringify({ avatar_url: avatar }),
                });
                const card = await res.json();
                return {
                    hasOverride: Boolean(info?.hasOverride),
                    diskOverride: card?.data?.extensions?.memory_graph?.schemaOverride ?? null,
                };
            });
        }, { timeout: 10_000 }).toEqual({ hasOverride: false, diskOverride: null });
        await closeWorkbench(page);
    });

    test('orch: upgrades spec string-shorthand node with tools and skills, applies and undoes', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        await openWorkbenchIterate(page, 'orch', { scope: 'global' });
        await expect.poll(() => readActiveSpecPreset(server.dataRoot)?.spec?.stages?.[0]?.nodes?.[0], { timeout: 10_000 })
            .toBe('distiller');

        mock.scriptCompletion((req) => {
            if (req.turn === 0) {
                return {
                    toolCalls: [
                        {
                            name: 'luker_orch_set_spec_node_tools',
                            arguments: {
                                stage_id: 'distill',
                                node_id: 'distiller',
                                tools: { lorebook: { list: true, get: true } },
                            },
                        },
                        {
                            name: 'skill_bind_to_agent',
                            arguments: {
                                agentId: 'distiller',
                                skillName: 'reef-protocol',
                                list: 'visible',
                            },
                        },
                    ],
                };
            }
            return { text: 'Enabled lorebook tools and bound reef-protocol skill on distiller.' };
        });

        await sendIteratePrompt(page, 'Give the distiller node lorebook read tools and bind the reef-protocol skill.');
        mock.clearScriptedCompletion();

        await applyIterateChanges(page);

        await expect.poll(() => {
            const spec = readActiveSpecPreset(server.dataRoot);
            return spec?.spec?.stages?.[0]?.nodes?.[0];
        }, { timeout: 10_000 }).toEqual(expect.objectContaining({
            id: 'distiller',
            preset: 'distiller',
            tools: expect.objectContaining({
                lorebook: expect.objectContaining({ list: true, get: true }),
            }),
            skills: expect.objectContaining({
                visible: expect.arrayContaining(['+', 'reef-protocol']),
            }),
        }));

        await undoIterateChanges(page);
        await expect.poll(() => {
            const spec = readActiveSpecPreset(server.dataRoot);
            return spec?.spec?.stages?.[0]?.nodes?.[0];
        }, { timeout: 10_000 }).toBe('distiller');
        await closeWorkbench(page);
    });
});
