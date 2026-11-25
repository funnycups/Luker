// #108 — Orchestrator iter-studio: a provider that reuses one tool-call id
// across responses. Rolling back the second turn must leave the first
// turn's approved change on disk.
//
// The mock LLM answers every tool-call response with the same id
// (`repeatToolCallId`), as providers that number calls per response do.
//
// REAL USER-GESTURE flow:
//   1. Open the orchestrator iter-studio; turn 1 updates the comment of
//      Eldoria uid 1 → Approve → worlds/Eldoria.json changes.
//   2. Turn 2 updates the comments of uid 2 and uid 3 in one response →
//      "Approve all pending" → both change on disk.
//   3. "Rollback this turn" on turn 2 → uid 2 and uid 3 return to their
//      original comments, uid 1 keeps turn 1's comment.

import { test, expect } from '../../harness/playwright.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import { openIterStudio, sendIterPrompt, applyIterBatch, rollbackIterBatch, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { normalizeIterStudioSettings } from './_helpers.js';

let server, mock;

const BOOK = 'Eldoria';
const TURN_1_PROMPT = 'Mark the Eldoria shadowfang entry as part of the harbor watch ledger.';
const TURN_2_PROMPT = 'Now tie the glade and power entries to the same ledger.';
const COMMENT_1 = 'shadowfang — harbor watch ledger';
const COMMENT_2 = 'glade — harbor watch ledger';
const COMMENT_3 = 'power — harbor watch ledger';
const FOLLOW_UP_1 = 'The shadowfang entry now names the harbor watch ledger.';
const FOLLOW_UP_2 = 'The glade and power entries now name the harbor watch ledger.';

function readEntry(dataRoot, uid) {
    const raw = JSON.parse(readFileSync(resolve(dataRoot, 'default-user', 'worlds', `${BOOK}.json`), 'utf8'));
    return raw?.entries?.[String(uid)] || null;
}

function lastUserText(userMessages) {
    return String(userMessages[userMessages.length - 1] || '');
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({ repeatToolCallId: 'call_0' });
    server = await startServer({ scope,
        batchKey: 'iterstudio',
        scenarioId: '108-orch-repeated-tool-call-id-rollback',
        extraConfig: { storage: { mode: 'fs' } },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    normalizeIterStudioSettings(server.dataRoot);
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#108 — Orchestrator iter-studio: repeated tool-call ids across turns', () => {
    test('rolling back turn 2 leaves turn 1 committed on disk', async ({ page }) => {
        const before1 = readEntry(server.dataRoot, 1);
        const before2 = readEntry(server.dataRoot, 2);
        const before3 = readEntry(server.dataRoot, 3);
        expect(before1.comment).not.toBe(COMMENT_1);

        // Each prompt's first request gets the tool calls; the round that
        // follows the approval gets plain text.
        const answered = new Set();
        mock.scriptCompletion(({ userMessages }) => {
            const last = lastUserText(userMessages);
            const prompt = last.includes(TURN_2_PROMPT) ? TURN_2_PROMPT : (last.includes(TURN_1_PROMPT) ? TURN_1_PROMPT : '');
            if (!prompt) return null;
            if (answered.has(prompt)) return { text: prompt === TURN_1_PROMPT ? FOLLOW_UP_1 : FOLLOW_UP_2 };
            answered.add(prompt);
            if (prompt === TURN_1_PROMPT) {
                return { toolCalls: [{ name: 'lorebook_update_entry', arguments: { book_name: BOOK, uid: 1, patch: { comment: COMMENT_1 } } }] };
            }
            return {
                toolCalls: [
                    { name: 'lorebook_update_entry', arguments: { book_name: BOOK, uid: 2, patch: { comment: COMMENT_2 } } },
                    { name: 'lorebook_update_entry', arguments: { book_name: BOOK, uid: 3, patch: { comment: COMMENT_3 } } },
                ],
            };
        });

        await awaitMainUI(page, server.baseURL);
        await openIterStudio(page, 'orch');
        const popup = page.locator('.wbench .wb-win');

        await sendIterPrompt(page, 'orch', TURN_1_PROMPT);
        await applyIterBatch(page, 'orch');
        await expect.poll(() => readEntry(server.dataRoot, 1)?.comment, { timeout: 15_000 }).toBe(COMMENT_1);
        await expect(popup).toContainText(FOLLOW_UP_1, { timeout: 15_000 });

        await sendIterPrompt(page, 'orch', TURN_2_PROMPT);
        await expect(popup.locator('.wb-chg.is-pending .wb-chg-line')).toHaveCount(2);
        await applyIterBatch(page, 'orch');
        await expect.poll(() => readEntry(server.dataRoot, 2)?.comment, { timeout: 15_000 }).toBe(COMMENT_2);
        await expect.poll(() => readEntry(server.dataRoot, 3)?.comment, { timeout: 15_000 }).toBe(COMMENT_3);
        await expect(popup).toContainText(FOLLOW_UP_2, { timeout: 15_000 });

        await rollbackIterBatch(page, 'orch');
        await expect.poll(() => readEntry(server.dataRoot, 2)?.comment, { timeout: 15_000 }).toBe(before2.comment);
        await expect.poll(() => readEntry(server.dataRoot, 3)?.comment, { timeout: 15_000 }).toBe(before3.comment);
        await expect(popup.locator('.wb-chg.is-discarded .wb-chg-foot button')).toHaveCount(0, { timeout: 15_000 });
        expect(readEntry(server.dataRoot, 1).comment).toBe(COMMENT_1);
        await expect(popup.locator('.wb-chg-line')).toHaveCount(3);
        await expect(popup.locator('.wb-chg.is-discarded .wb-chg-line')).toHaveCount(2);
        await expect(popup.locator('.wb-chg.is-applied .wb-chg-line')).toHaveCount(1);

        await closeIterStudio(page);
    });
});
