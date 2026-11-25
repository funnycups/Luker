// #105 — CEA editor iter-studio: a failed edit reaches the model in the
// next round of the same turn.
//
// Round 1 reads the description and issues a str_replace whose anchor is
// not in the live text. Round 2 must see both calls on the replayed
// assistant message, each answered by its own role:'tool' message, with
// the str_replace result carrying the structured not_found error.
//
// Real UI/gestures: select Seraphina → Extensions drawer → CEA → "Open
// Editor" → type → Send. mockLLM scripts the two rounds.

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { openIterStudio, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { normalizeIterStudioSettings } from '../preset/_helpers.js';

const ABSENT_ANCHOR = 'a sentence the description has never contained';
const FOLLOW_UP = 'That line is not in her description, so I will reread it before patching.';

let server, mock;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope,
        batchKey: 'iterstudio',
        scenarioId: '105-cea-failed-edit-replayed-in-turn',
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    normalizeIterStudioSettings(server.dataRoot);
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#105 — CEA editor failed edit replay within a turn', () => {
    test('the second round request carries the failed str_replace result', async ({ page }) => {
        const requestMessages = [];
        mock.scriptCompletion(({ turn, body }) => {
            requestMessages.push(body?.messages || []);
            if (turn === 0) {
                return {
                    toolCalls: [
                        { name: 'cea_read_card_fields', arguments: { fields: ['description'] } },
                        { name: 'cea_str_replace_card_field', arguments: { field: 'description', oldString: ABSENT_ANCHOR, newString: 'Seraphina hums while she tends the glade.' } },
                    ],
                };
            }
            return { text: FOLLOW_UP };
        });

        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await openIterStudio(page, 'cea');
        const popup = page.locator('.wbench .wb-win');
        await popup.locator('.wb-chat .wb-input')
            .fill('Have Seraphina hum while she tends the glade.');
        await popup.locator('.wb-chat .wb-send').click();
        await expect(popup).toContainText(FOLLOW_UP, { timeout: 30_000 });

        expect(requestMessages).toHaveLength(2);
        const round2 = requestMessages[1];
        const assistant = round2.find(m => m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0);
        expect(assistant.tool_calls.map(c => c.function?.name)).toEqual(['cea_read_card_fields', 'cea_str_replace_card_field']);
        const replaceCallId = assistant.tool_calls[1].id;
        const readCallId = assistant.tool_calls[0].id;
        expect(replaceCallId).toBeTruthy();
        expect(replaceCallId).not.toBe(readCallId);

        const toolMessages = round2.filter(m => m?.role === 'tool');
        expect(toolMessages.map(m => m.tool_call_id)).toEqual([readCallId, replaceCallId]);
        const replaceResult = JSON.parse(toolMessages[1].content);
        expect(replaceResult).toMatchObject({ ok: false, error: 'not_found' });
        expect(replaceResult.match_diagnosis).toBeDefined();

        mock.clearScriptedCompletion();
        await closeIterStudio(page);
    });
});
