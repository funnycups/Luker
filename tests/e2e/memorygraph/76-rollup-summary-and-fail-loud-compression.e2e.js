// tests/e2e/memorygraph/76-rollup-summary-and-fail-loud-compression.e2e.js
//
// #76 — End-to-end verification of:
//   1. Non-event rollup compression using strictly `luker_rpg_summary` (never
//      `luker_rpg_summary_fields`) with leaf tableColumns serialized into the prompt.
//   2. Fail-loud Scheme A error propagation: when compression fails (empty summary
//      with toolCallRetryMax: 0), an error toast surfaces, subsequent extraction
//      batches stop immediately, and already-committed leaf batches remain
//      untouched (`parentId: ''`, `archived: false`).
//   3. Recovery on the next Fill Graph: remaining batch extracts, leaves compress
//      into an L1 rollup node whose `fields` is strictly `{ summary }`, and the
//      rollup persists across server restart.
//   4. Memory Lens Data table & Inspector UI: `moment` tab renders the rollup row
//      with a single `colSpan` summary cell, and clicking it opens Inspector with
//      `.ml-insp-prose` summary + `.ml-insp-children` listing the 2 child leaves.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { disableTagImportPopup, writeEmbeddedCharacter } from '../character/_helpers.js';
import {
    awaitMainUI,
    closeTopDrawer,
    openTopDrawer,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    reloadAndAwait,
} from '../_lib/page.js';
import { closeWorkbench, workbenchWindow } from '../_lib/ui-workbench.js';
import {
    fillMgGraph,
    openMemoryWorkspace,
    openMgSchemaEditor,
    setMgSettings,
} from '../_lib/ui-mg-varops.js';

const RP_TURNS = [
    {
        user: 'Ash, the storm lantern sputtered out above the headland steps. Did you bring the spare flint from the boathouse?',
        reply: '*Ash kneels beside the lantern housing, shielding the glass with her wool cloak before striking a spark.* "Found it tucked behind the dry ropes. Here—keep the wind off my hands until the wick catches."',
    },
    {
        user: 'The tide washed a carved cedar compass onto the shingle below the pier. Take a look at the lid.',
        reply: '*Ash turns the salt-bleached case over, thumb tracing the worn compass rose etched into the cedar.* "My father used this mark on his soundings. Keep it dry inside your coat tonight."',
    },
    {
        user: 'The third buoy bell finally rang across the channel—the salt-mark skiff made it past the breakers.',
        reply: '*Ash lowers her spyglass and lets out a long breath into the mist.* "Three lanterns lit on the far spit. They made the crossing cleanly before the surge."',
    },
];

const EVENT_SUMMARIES = {
    1: 'Time: Dusk\nPlace: Headland steps\n\nAsh relit the storm lantern with the spare boathouse flint.',
    2: 'Time: Nightfall\nPlace: Shingle beach\n\nA carved cedar compass washed ashore and Ash recognized her father’s sounding mark.',
    3: 'Time: Late night\nPlace: Bryn watchpost\n\nThree lanterns on the far spit confirmed the salt-mark skiff cleared the reef.',
};

const MOMENT_FIXTURES = {
    1: {
        title: 'Storm Lantern Relit',
        when: 'Dusk, headland steps',
        detail: 'Ash shielded the wick with her cloak while striking the boathouse flint.',
        meaning: 'First quiet moment of trust in the gale.',
    },
    2: {
        title: 'Cedar Compass Gift',
        when: 'Nightfall, shingle beach',
        detail: 'Ash recognized her father’s mark on the salvaged compass and entrusted it to you.',
        meaning: 'Shared a family heirloom across the watch.',
    },
    3: {
        title: 'Channel Crossing Signal',
        when: 'Late night, watchpost rail',
        detail: 'Three lanterns flared across the channel confirming the skiff cleared the breakers.',
        meaning: 'Relief after the longest watch.',
    },
};

const ROLLUP_SUMMARY = 'Ash and you forged quiet trust on the headland—relighting the storm lantern together and sharing her father’s cedar compass.';

const EVENT_TOOL = 'luker_rpg_extract_event_create';
const MOMENT_TOOL = 'luker_rpg_extract_moment_create';
const DONE_TOOL = 'luker_rpg_extract_done';
const SUMMARY_TOOL = 'luker_rpg_summary';
const LEGACY_SUMMARY_FIELDS_TOOL = 'luker_rpg_summary_fields';

function messageText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map((part) => (typeof part === 'string' ? part : (part?.text || ''))).join('');
    }
    return '';
}

function extractionBatchSeq(messages) {
    const seqs = [];
    for (const message of Array.isArray(messages) ? messages : []) {
        const text = messageText(message?.content);
        const re = /<seq>(\d+)<\/seq>/g;
        let match;
        while ((match = re.exec(text)) !== null) {
            seqs.push(Number(match[1]));
        }
    }
    return seqs.length > 0 ? Math.max(...seqs) : null;
}

async function connectCustomApiViaUI(page) {
    await openTopDrawer(page, 'sys-settings-button');
    await page.locator('#api_button_openai').click();
    await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });
    await closeTopDrawer(page, 'sys-settings-button');
}

async function installToastObserver(page) {
    await page.evaluate(() => {
        window.__toastCaptures = [];
        const seen = new Set();
        const scan = () => {
            for (const msgEl of document.querySelectorAll('.toast-message')) {
                const text = String(msgEl.textContent || '').trim();
                const isError = Boolean(msgEl.closest('.toast')?.classList.contains('toast-error'));
                const key = `${isError ? 'err' : 'info'}:${text}`;
                if (text && !seen.has(key)) {
                    seen.add(key);
                    window.__toastCaptures.push({ text, isError });
                }
            }
        };
        scan();
        new MutationObserver(scan).observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['class'],
        });
    });
}

async function readStoreSnapshot(page) {
    return page.evaluate(async () => {
        const ctx = window.Luker.getContext();
        const main = await import('/scripts/extensions/memory-graph/main.js');
        const store = await main.ensureMemoryStoreLoaded(ctx);
        if (!store) return null;
        const nodes = Object.values(store.nodes || {}).map((node) => ({
            id: String(node.id || ''),
            type: String(node.type || ''),
            title: String(node.title || ''),
            fields: JSON.parse(JSON.stringify(node.fields || {})),
            parentId: String(node.parentId || ''),
            childrenIds: Array.isArray(node.childrenIds) ? node.childrenIds.slice() : [],
            archived: Boolean(node.archived),
            semanticRollup: Boolean(node.semanticRollup),
            semanticDepth: Number(node.semanticDepth || 0),
            seqTo: Number(node.seqTo ?? 0),
        }));
        return {
            appliedSeqTo: Number(store.appliedSeqTo ?? 0),
            nodes,
        };
    });
}

async function readMomentSchemaSpec(page) {
    return page.evaluate(() => {
        const ctx = window.Luker.getContext();
        const mg = ctx.getExtensionApi?.('memory-graph');
        const info = mg?.getSchemaScopeInfo?.(ctx);
        return Array.isArray(info?.schema) ? info.schema.find((t) => t?.id === 'moment') || null : null;
    });
}

test.describe('#76 — non-event rollup summary and fail-loud compression', () => {
    let server, mock;
    let shouldFailCompression = true;
    const extractionCalls = [];
    const compressionCalls = [];

    test.beforeAll(async () => {
        mock = await startMockLLM({
            scriptedReplies: RP_TURNS.map((t) => t.reply),
        });
        server = await startServer({ batchKey: 'memorygraph', scenarioId: 'rollup-summary-fail-loud' });
        markOnboarded({ dataRoot: server.dataRoot });
        bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
        appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
        disableTagImportPopup({ dataRoot: server.dataRoot });
        writeEmbeddedCharacter({
            dataRoot: server.dataRoot,
            overrides: {
                first_mes: '',
                alternate_greetings: [],
                chat: 'Ash the Cartographer - Rollup E2E',
            },
        });

        mock.scriptCompletion((req) => {
            const names = req.toolNames || [];
            if (names.includes(SUMMARY_TOOL) || names.includes(LEGACY_SUMMARY_FIELDS_TOOL)) {
                compressionCalls.push({
                    toolNames: names.slice(),
                    systemText: (req.systemPrompts || []).join('\n'),
                    userText: (req.userMessages || []).join('\n'),
                });
                if (shouldFailCompression) {
                    return {
                        toolCalls: [{ name: SUMMARY_TOOL, arguments: { summary: '' } }],
                    };
                }
                return {
                    toolCalls: [{ name: SUMMARY_TOOL, arguments: { summary: ROLLUP_SUMMARY } }],
                };
            }

            if (names.includes(DONE_TOOL) && names.includes(EVENT_TOOL)) {
                const seq = extractionBatchSeq(req.body?.messages);
                extractionCalls.push({ seq, toolNames: names.slice() });
                const toolCalls = [
                    {
                        name: EVENT_TOOL,
                        arguments: {
                            summary: EVENT_SUMMARIES[seq] || `Time: Night\nPlace: Bryn watchpost\n\nEvent ${seq}.`,
                            links: [],
                            no_link_reason: 'mock',
                        },
                    },
                ];
                if (names.includes(MOMENT_TOOL) && MOMENT_FIXTURES[seq]) {
                    toolCalls.push({
                        name: MOMENT_TOOL,
                        arguments: { ...MOMENT_FIXTURES[seq] },
                    });
                }
                toolCalls.push({ name: DONE_TOOL, arguments: {} });
                return { toolCalls };
            }

            return null;
        });
    });

    test.afterAll(async () => {
        await tearDownServer(server);
        await mock?.stop();
    });

    test('fail-loud compression stops batch 3 and preserves leaves; retry fill creates single-summary rollup rendered in Lens', async ({ page }) => {
        test.setTimeout(240_000);
        await awaitMainUI(page, server.baseURL);
        await connectCustomApiViaUI(page);
        await selectCharacterByName(page, 'Ash the Cartographer');

        // Ensure MG starts disabled regardless of any pre-populated settings.json before sending setup turns.
        await setMgSettings(page, { enabled: false }, { closeAfter: true });

        // 1. Send 3 real RP turns while MG is off (first_mes is empty, so 3 turns = 3 extractable assistant floors).
        for (const turn of RP_TURNS) {
            await sendMessageAndAwaitReply(page, turn.user);
        }
        await expect(page.locator('#chat .mes')).toHaveCount(6);
        expect(extractionCalls, 'no extraction should fire while MG is off').toHaveLength(0);

        // 2. Enable MG with autoExtraction off, autoCompression on, recall off, oneshot mode, sequential batch=1, retry=0.
        await setMgSettings(page, {
            autoExtractionEnabled: false,
            autoCompressionEnabled: true,
            recallEnabled: false,
            extractMode: 'oneshot',
            extractConcurrent: false,
            updateEvery: 1,
            extractBatchTurns: 1,
            extractExcludeRecentTurns: 0,
            toolCallRetryMax: 0,
            enabled: true,
        });
        const settingsLens = workbenchWindow(page).locator('.mlens').first();
        await expect(settingsLens.locator('.ml-settings-sticky')).not.toHaveClass(/\bis-dirty\b/, { timeout: 10_000 });

        // 3. Open Memory Structure, apply "Romance and daily life" template, enable compression on `moment`.
        const schema = await openMgSchemaEditor(page);
        await schema.locator('.ml-schema-list-actions button')
            .filter({ hasText: /^(Apply template|套用模板|套用範本)$/ })
            .first()
            .click();

        const tplModal = page.locator('.wbench .mlens .ml-dialog-backdrop:has(.ml-tpls)').last();
        await tplModal.waitFor({ state: 'visible', timeout: 5000 });
        await tplModal.locator('button.ml-tpl[data-id="romance"]').click();
        await expect(tplModal.locator('button.ml-tpl[data-id="romance"]')).toHaveAttribute('aria-checked', 'true');
        await tplModal.locator('.ml-schema-modal-foot .lw-btn.is-primary').first().click();
        await tplModal.waitFor({ state: 'detached', timeout: 5000 });

        const momentTypeBtn = schema.locator('.ml-schema-list .ml-schema-type', {
            has: page.locator('.ml-schema-type-name', { hasText: /^(Memorable moment|纪念时刻|紀念時刻)$/ }),
        }).first();
        await momentTypeBtn.click();
        await expect(momentTypeBtn).toHaveAttribute('aria-selected', 'true');

        const compressionSwitch = schema.locator('.ml-schema-flags button.ml-schema-flag[role="switch"]', {
            has: page.locator('.ml-schema-flag-title', { hasText: /^(Merge into summaries automatically|自动合并成摘要|自動合併成摘要)$/ }),
        }).first();
        await compressionSwitch.scrollIntoViewIfNeeded();
        await expect(compressionSwitch).toHaveAttribute('aria-checked', 'false');
        await compressionSwitch.click();
        await expect(compressionSwitch).toHaveAttribute('aria-checked', 'true');

        const advSection = schema.locator('.ml-aiset').first();
        await advSection.scrollIntoViewIfNeeded();

        const thresholdInput = advSection.locator('.ml-aiset-field', {
            has: page.locator('.ml-aiset-label', { hasText: /^(Threshold|阈值|閾值)$/ }),
        }).locator('input').first();
        const fanInInput = advSection.locator('.ml-aiset-field', {
            has: page.locator('.ml-aiset-label', { hasText: /^(Fan-In|扇入)$/ }),
        }).locator('input').first();
        const keepRecentInput = advSection.locator('.ml-aiset-field', {
            has: page.locator('.ml-aiset-label', { hasText: /^(Keep Recent Leaves|保留最近叶子|保留最近葉節點)$/ }),
        }).locator('input').first();

        await thresholdInput.fill('2');
        await fanInInput.fill('2');
        await keepRecentInput.fill('0');
        await expect(thresholdInput).toHaveValue('2');
        await expect(fanInInput).toHaveValue('2');
        await expect(keepRecentInput).toHaveValue('0');

        const schemaSaveBtn = schema.locator('.ml-schema-bar .lw-btn.is-primary').first();
        await expect(schemaSaveBtn).toBeEnabled({ timeout: 5000 });
        await schemaSaveBtn.click();

        const confirmModal = page.locator('.wbench .mlens .ml-dialog-backdrop:has(.ml-schema-modal)').last();
        await confirmModal.waitFor({ state: 'visible', timeout: 5000 });
        const settingsSavedPromise = page.waitForResponse((res) => {
            const path = new URL(res.url()).pathname;
            return (path === '/api/settings/save' || path === '/api/settings/patch') && res.request().method() === 'POST';
        });
        await confirmModal.locator('.ml-schema-modal-foot .lw-btn.is-primary').first().click();
        await confirmModal.waitFor({ state: 'detached', timeout: 10_000 });
        expect((await settingsSavedPromise).ok()).toBe(true);
        await expect(schemaSaveBtn).toBeDisabled({ timeout: 10_000 });

        const savedMomentSpec = await readMomentSchemaSpec(page);
        expect(savedMomentSpec).not.toBeNull();
        expect(savedMomentSpec.tableColumns).toEqual(['title', 'when', 'detail', 'meaning']);
        expect(savedMomentSpec.latestOnly).toBe(false);
        expect(savedMomentSpec.compression).toMatchObject({
            mode: 'hierarchical',
            threshold: 2,
            fanIn: 2,
            keepRecentLeaves: 0,
        });

        // 4-5. First Fill run: batch 2 hits moment threshold=2, compression fails loudly -> batch 3 never runs.
        await installToastObserver(page);
        shouldFailCompression = true;
        await fillMgGraph(page, { closeAfter: false });

        const fillBtn = settingsLens.locator('[data-settings-section="operations"] button')
            .filter({ hasText: /^(Fill Graph|补全图谱|補全圖譜)$/ })
            .first();

        await expect.poll(
            () => page.evaluate(() => (window.__toastCaptures || []).filter((t) => t.isError)),
            { timeout: 120_000, intervals: [200, 300, 500] },
        ).toEqual(expect.arrayContaining([
            expect.objectContaining({
                isError: true,
                text: expect.stringMatching(/Memory graph operation failed|记忆图操作失败|記憶圖操作失敗/),
            }),
        ]));
        await expect(fillBtn).toBeEnabled({ timeout: 30_000 });

        expect(extractionCalls.map((c) => c.seq), 'batch 3 extraction must not fire after batch 2 compression fails')
            .toEqual([1, 2]);
        expect(compressionCalls, 'exactly one compression call should have fired after batch 2').toHaveLength(1);
        expect(compressionCalls[0].toolNames).toEqual([SUMMARY_TOOL]);
        expect(compressionCalls[0].toolNames).not.toContain(LEGACY_SUMMARY_FIELDS_TOOL);
        expect(compressionCalls[0].userText).toContain('"when"');
        expect(compressionCalls[0].userText).toContain('"detail"');
        expect(compressionCalls[0].userText).toContain('"meaning"');
        expect(compressionCalls[0].userText).toContain(MOMENT_FIXTURES[1].detail);
        expect(compressionCalls[0].userText).toContain(MOMENT_FIXTURES[2].detail);

        const afterFailedFill = await readStoreSnapshot(page);
        expect(afterFailedFill).not.toBeNull();
        expect(afterFailedFill.appliedSeqTo).toBe(2);

        const failedEvents = afterFailedFill.nodes.filter((n) => n.type === 'event');
        const failedMoments = afterFailedFill.nodes.filter((n) => n.type === 'moment');
        expect(failedEvents).toHaveLength(2);
        expect(failedMoments).toHaveLength(2);
        expect(failedMoments.some((n) => n.semanticRollup)).toBe(false);
        for (const leaf of failedMoments) {
            expect(leaf.parentId).toBe('');
            expect(leaf.archived).toBe(false);
        }

        // 6. Switch compression to succeed, click Fill Graph again -> batch 3 extracts & moment leaves roll up.
        shouldFailCompression = false;
        await fillMgGraph(page, { closeAfter: false });

        await expect.poll(() => compressionCalls.length, { timeout: 120_000, intervals: [200, 300, 500] }).toBe(2);
        await expect(fillBtn).toBeEnabled({ timeout: 60_000 });

        expect(extractionCalls.map((c) => c.seq)).toEqual([1, 2, 3]);
        expect(compressionCalls[1].toolNames).toEqual([SUMMARY_TOOL]);
        expect(compressionCalls[1].toolNames).not.toContain(LEGACY_SUMMARY_FIELDS_TOOL);
        expect(compressionCalls[1].userText).toContain('"when"');
        expect(compressionCalls[1].userText).toContain('"detail"');
        expect(compressionCalls[1].userText).toContain('"meaning"');

        const afterRecoveredFill = await readStoreSnapshot(page);
        expect(afterRecoveredFill).not.toBeNull();
        expect(afterRecoveredFill.appliedSeqTo).toBe(3);

        const checkRollupStore = (snap) => {
            const events = snap.nodes.filter((n) => n.type === 'event');
            const moments = snap.nodes.filter((n) => n.type === 'moment');
            const rollups = moments.filter((n) => n.semanticRollup);
            const leaves = moments.filter((n) => !n.semanticRollup);

            expect(events).toHaveLength(3);
            expect(rollups).toHaveLength(1);
            expect(leaves).toHaveLength(3);

            const rollup = rollups[0];
            expect(rollup.semanticDepth).toBe(1);
            expect(rollup.archived).toBe(false);
            expect(Object.keys(rollup.fields)).toEqual(['summary']);
            expect(rollup.fields.summary).toBe(ROLLUP_SUMMARY);
            expect(rollup.childrenIds).toHaveLength(2);

            const childSet = new Set(rollup.childrenIds);
            const rollupChildren = leaves.filter((n) => childSet.has(n.id));
            const remainingLeaf = leaves.find((n) => !childSet.has(n.id));

            expect(rollupChildren).toHaveLength(2);
            for (const child of rollupChildren) {
                expect(child.parentId).toBe(rollup.id);
                expect(child.archived).toBe(false);
            }
            expect(remainingLeaf).toBeDefined();
            expect(remainingLeaf.seqTo).toBe(3);
            expect(remainingLeaf.parentId).toBe('');
            expect(remainingLeaf.archived).toBe(false);

            return { rollup, rollupChildren, remainingLeaf };
        };

        const preRestart = checkRollupStore(afterRecoveredFill);
        await closeWorkbench(page);

        // Verify persistence across server restart and page reload.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Ash the Cartographer');

        await expect.poll(async () => {
            const snap = await readStoreSnapshot(page);
            return snap?.nodes?.length ?? 0;
        }, { timeout: 30_000, intervals: [200, 300, 500] }).toBeGreaterThanOrEqual(7);

        const postRestart = await readStoreSnapshot(page);
        expect(postRestart.appliedSeqTo).toBe(3);
        const persisted = checkRollupStore(postRestart);
        expect(persisted.rollup.id).toBe(preRestart.rollup.id);

        // Verify MG enabled state and `moment` schema persist cleanly across server restart.
        const postRestartSettingsLens = await openMemoryWorkspace(page, { subview: 'settings' });
        await expect(postRestartSettingsLens.locator('.ml-settings [data-field-key="enabled"]').first())
            .toHaveAttribute('aria-checked', 'true');
        const postRestartMomentSpec = await readMomentSchemaSpec(page);
        expect(postRestartMomentSpec).not.toBeNull();
        expect(postRestartMomentSpec.tableColumns).toEqual(['title', 'when', 'detail', 'meaning']);
        expect(postRestartMomentSpec.compression).toMatchObject({
            mode: 'hierarchical',
            threshold: 2,
            fanIn: 2,
            keepRecentLeaves: 0,
        });

        // Open Workbench -> Memory Graph -> Data table -> moment tab -> rollup row + Inspector.
        const lens = await openMemoryWorkspace(page, { subview: 'table' });
        const win = workbenchWindow(page);
        const maxBtn = win.locator('button[aria-label="Maximize"], button[aria-label="最大化"], button[aria-label="放大"]').first();
        await maxBtn.waitFor({ state: 'visible', timeout: 5000 });
        await maxBtn.click();
        await expect(lens).not.toHaveClass(/\bis-compact\b/, { timeout: 10_000 });

        const momentTab = lens.locator('.ml-table-head .lw-seg-btn').filter({
            has: page.locator('.lw-seg-label', { hasText: /^(Memorable moment|纪念时刻|紀念時刻)$/ }),
        }).first();
        await momentTab.waitFor({ state: 'visible', timeout: 10_000 });
        await momentTab.click();
        await expect(momentTab).toHaveAttribute('aria-pressed', 'true');

        const rollupRow = lens.locator(`.ml-table tbody tr[data-id="${persisted.rollup.id}"]`);
        await rollupRow.waitFor({ state: 'visible', timeout: 10_000 });
        await expect(rollupRow.locator('.ml-td-title .ml-tl-tag')).toBeVisible();

        const rollupBodyCells = rollupRow.locator('td:not(.ml-td-title):not(.ml-td-num):not(.ml-td-ctx)');
        await expect(rollupBodyCells).toHaveCount(1);
        await expect(rollupBodyCells.first()).toHaveAttribute('colspan', '3');
        await expect(rollupBodyCells.first()).toContainText(ROLLUP_SUMMARY);

        const leafRow = lens.locator(`.ml-table tbody tr[data-id="${persisted.remainingLeaf.id}"]`);
        await expect(leafRow).toBeVisible();
        await expect(leafRow.locator('td:not(.ml-td-title):not(.ml-td-num):not(.ml-td-ctx)')).toHaveCount(3);

        await rollupRow.click();

        const inspector = lens.locator('.ml-inspector');
        await expect(inspector).toBeVisible({ timeout: 10_000 });
        await expect(inspector.locator('.ml-insp-head .ml-tl-tag')).toBeVisible();
        await expect(inspector.locator('.ml-insp-fields')).toHaveCount(0);

        const prose = inspector.locator('.ml-insp-prose');
        await expect(prose).toBeVisible();
        await expect(prose).toContainText(ROLLUP_SUMMARY);

        const childLinks = inspector.locator('.ml-insp-children .ml-nodelink');
        await expect(childLinks).toHaveCount(2);
        await expect(childLinks.locator('.ml-nodelink-title')).toHaveText([
            MOMENT_FIXTURES[1].title,
            MOMENT_FIXTURES[2].title,
        ]);
    });
});
