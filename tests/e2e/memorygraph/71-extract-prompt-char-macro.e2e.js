// tests/e2e/memorygraph/71-extract-prompt-char-macro.e2e.js
//
// #71 — macros in a user-edited extraction prompt render before the
// request leaves the browser.
//
// Real-user flow:
//   1. Chat two RP turns with MG off.
//   2. Enable MG (auto extraction off), open Advanced, replace the
//      "Extract Table Fill Prompt" with a prompt that names {{char}}.
//   3. Click Fill Graph and wait for the completion status line.
//
// Pins: every extraction request carries the prompt with {{char}}
// rendered as the active character's name, and none carries the literal.

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { disableTagImportPopup, writeEmbeddedCharacter } from '../character/_helpers.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';
import { closeWorkbench } from '../_lib/ui-workbench.js';
import { setMgSettings } from '../_lib/ui-mg-varops.js';
import {
    EXTRACT_EVENT_TOOL,
    FILL_DONE_STATUS,
    recordsWithTool,
    disableMemoryGraphInSettingsFile,
    clickFillGraph,
    memoryGraphStatus,
} from './_runner-helpers.js';

const TURNS = [
    'The harbor ledger lists the lantern-oil delivery as short by two casks.',
    'I found the missing casks stacked under the customs house stairs.',
];

const REPLIES = [
    '*Ash runs a thumb down the ledger column and frowns.* "Two casks short, and the tally is in the clerk\'s own hand."',
    '*Ash crouches to read the brand on the cask lids.* "Harbor stock. Someone meant to sell these after dark."',
];

const CUSTOM_EXTRACT_PROMPT = [
    'You are the harbor archivist who keeps {{char}}\'s tide ledger.',
    'Record only events the dialogue grounds, in the order they happened.',
    '{{nodes}}',
    '{{edges}}',
].join('\n');
const RENDERED_LINE = 'You are the harbor archivist who keeps Ash the Cartographer\'s tide ledger.';
const LITERAL_LINE = 'You are the harbor archivist who keeps {{char}}\'s tide ledger.';

let server, mock;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({ scriptedReplies: [...REPLIES] });
    server = await startServer({ scope, batchKey: 'memorygraph', scenarioId: 'extract-prompt-char-macro' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    disableTagImportPopup({ dataRoot: server.dataRoot });
    writeEmbeddedCharacter({ dataRoot: server.dataRoot });
    disableMemoryGraphInSettingsFile(server.dataRoot);

    mock.scriptCompletion((req) => {
        const names = req.toolNames || [];
        if (names.includes(EXTRACT_EVENT_TOOL)) {
            return {
                toolCalls: [
                    { name: EXTRACT_EVENT_TOOL, arguments: { summary: '时间：黄昏；Ash 在海关楼梯下找到短缺的两桶灯油。', links: [], no_link_reason: 'No related node is recorded yet.' } },
                    { name: 'luker_rpg_extract_done', arguments: {} },
                ],
            };
        }
        return null;
    });
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#71 — {{char}} renders in a custom extract prompt', () => {
    test.setTimeout(240_000);

    test('Fill Graph sends the custom prompt with the character name substituted', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash the Cartographer');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, null, { timeout: 30_000 });

        for (const turn of TURNS) {
            await sendMessageAndAwaitReply(page, turn);
        }

        // Auto extraction goes off before MG turns on, so enabling never
        // starts an extraction with the default prompt.
        await setMgSettings(page, {
            autoExtractionEnabled: false,
            enabled: true,
            extractTemplate: CUSTOM_EXTRACT_PROMPT,
        });

        await clickFillGraph(page);
        await expect(memoryGraphStatus(page)).toHaveText(FILL_DONE_STATUS, { timeout: 180_000 });
        await closeWorkbench(page);

        const extractionBodies = recordsWithTool(mock, EXTRACT_EVENT_TOOL).map(record => record.body);
        expect(extractionBodies.length, 'Fill Graph must send extraction requests').toBeGreaterThanOrEqual(1);
        for (const body of extractionBodies) {
            const blob = JSON.stringify(body.messages);
            expect(blob, 'the custom prompt arrives with {{char}} rendered').toContain(RENDERED_LINE);
            expect(blob, 'no literal {{char}} reaches the model').not.toContain(LITERAL_LINE);
        }
    });
});
