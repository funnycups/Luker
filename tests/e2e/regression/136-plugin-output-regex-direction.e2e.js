// #136 — Plugin output-direction regex cooks the text a plugin request returns.
//
// A rule scoped to Alter Plugin Messages without Alter Outgoing Prompt
// (pluginOnly, no promptOnly) rewrites the assistant text a plugin request
// returns. Core applies that pass inside generateTask before the terminal
// result resolves. The regression locks it on a real path: a director sub-agent
// returns a sentinel as its terminal text, and the pluginOnly-only rule must
// cook it before the text crosses back to the parent through the
// await_subagents tool_result.
//
// Sentinel scheme: the sub-agent's reply carries `PLUGOUTSENTINEL`; the rule
// rewrites it to `PLUGOUTCOOKED`. The parent's outgoing request carries the
// tool_result, so the wire must show COOKED and never the raw sentinel.

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import {
    bootstrapCustomBackend,
    appendConnectionProfile,
    markOnboarded,
} from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    installMinimalDirectorProfile,
} from '../_lib/page.js';

const SENTINEL = 'PLUGOUTSENTINEL';
const COOKED = 'PLUGOUTCOOKED';
const SUBAGENT_REPLY = `The chart shows ${SENTINEL} at slack water; keep the mark where the current splits.`;
const DIRECTOR_DRAFT = '*Ash unrolls the survey chart and weights its corners.* "Then we keep the mark."';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: ['*ack*'] });
    server = await startServer({ batchKey: 'orchestrator', scenarioId: '136-plugin-output-regex' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    const settingsPath = resolve(server.dataRoot, 'default-user', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    settings.extension_settings = settings.extension_settings || {};
    settings.extension_settings.regex = [
        {
            id: 'e2e-plugin-output-lane',
            scriptName: 'Plugin output lane',
            findRegex: `/${SENTINEL}/g`,
            replaceString: COOKED,
            placement: [1, 2],
            disabled: false,
            markdownOnly: false,
            pluginOnly: true,
            minDepth: null,
            maxDepth: null,
        },
    ];
    writeFileSync(settingsPath, JSON.stringify(settings, null, 4));
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#136 — plugin output-direction regex', () => {
    test('cooks the assistant text a plugin request returns before the parent sees it', async ({ page }) => {
        test.setTimeout(180_000);
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await installMinimalDirectorProfile(page, {
            mainSystemPrompt: 'You are the test director. Use write_message, dispatch_subagent, await_subagents, finalize.',
            subAgents: [
                {
                    id: 'scout',
                    description: 'Test stub scout. Returns one line.',
                    systemPrompt: 'You are the scout. Reply with a single line.',
                },
            ],
        });

        mock.scriptDirectorRun({
            route: ({ role, turn }) => {
                if (role === 'director-main' && turn === 0) {
                    return { toolCalls: [
                        { name: 'write_message', arguments: { text: DIRECTOR_DRAFT, mode: 'replace' } },
                        { name: 'dispatch_subagent', arguments: { subagentId: 'scout', task: 'read the reef chart' } },
                    ] };
                }
                if (role === 'subagent') {
                    // The scout's terminal text becomes its outputText and
                    // crosses back to the parent via await_subagents.
                    return { text: SUBAGENT_REPLY };
                }
                if (role === 'director-main' && turn === 1) {
                    return { tool: 'await_subagents', arguments: { handles: ['subagent-0'] } };
                }
                if (role === 'director-main' && turn === 2) {
                    return { tool: 'finalize', arguments: {} };
                }
                return null;
            },
        });

        await sendMessageAndAwaitReply(
            page,
            '*Hand on the rail, eyes seaward.* "Read the reef for me."',
            { timeoutMs: 90_000 },
        );

        const bodies = mock.requests.map(r => JSON.stringify(r.body));
        expect(bodies.some(b => b.includes(COOKED)), 'the sub-agent output should reach the parent cooked').toBe(true);
        expect(bodies.some(b => b.includes(SENTINEL)), 'the raw sentinel must not survive to any outgoing request').toBe(false);
    });
});
