// Case #76 — Re-run from step N
//
// Original brief:
//   - After an N-step run completes, select step k → re-run from there.
//   - Steps k+1..N re-execute fresh; steps 0..k-1 preserved.
//
// Verified product gap (re-audited 2026-06-14):
//   No orchestrator mode exposes "re-run from step N" today.
//
//   Audit trail:
//     - Run panel UI (`run-panel/panel.js`): the only header actions are
//       stop / export / collapse-all / close. The per-round summary
//       (`render-incremental.js::_renderRoundAppended`) renders each round
//       as a `<details>` block with no per-round affordance — no
//       "rerun from here" button, no round-selection handler. The i18n
//       keys "Rollback round" / "Rolled back to selected round." exist
//       in `i18n.js` but are never referenced (dead translations).
//     - Slash commands: the orchestrator extension registers none
//       (`grep registerSlashCommand public/scripts/extensions/orchestrator/`
//       returns no hits).
//     - Director runtime (`director-runtime.js`): processes one main-agent
//       turn per dispatch; no "resume from sub-agent N" entry point.
//     - Spec runtime (`spec-runtime.js`): has `replayStagesToReview` which
//       replays from the earliest stage targeted by a REVIEW node's
//       `luker_orch_review_rerun` decision. That is in-orchestration,
//       LLM-driven, scoped to worker nodes the critic flagged — NOT a
//       user-driven post-run "click step k, restart from k+1" feature.
//     - Agenda runtime (`agenda-runtime.js`): records `reviewRerunCount`
//       and `rerunReason` on each attempt for the same review-rerun
//       machinery; again, not user-driven post-run.
//     - Loop runtime (`loop-runtime.js`): a single agent calling tools in
//       a single conversation; "rounds" here are sequential and not
//       restartable by selection. `reviewRerunCount: 0` is hard-coded.
//
// The closest analog in the codebase is iter-studio's per-leaf
// re-iterate (`iter-studio/studio.js`), which operates on a different
// unit (skill iteration tree branches, not run-state rounds).
//
// Test shape:
//   We assert the **shape the feature would have if implemented**, and
//   mark it `test.fail()` so the test currently fails-as-expected. The
//   day someone wires the feature, the assertions start passing →
//   Playwright reports "unexpected pass" → the developer is forced to
//   remove the `test.fail` and either own the spec or rewrite it.
//
//   What we look for:
//     a) UI affordance on a completed-run round (a button / data action
//        on the run panel's `[data-round-id]` list items, OR a slash
//        command that takes a round id).
//     b) RunStateStore API that truncates rounds at index k and emits
//        a resumable run (e.g. `rerunFromRound`, `truncateRoundsFrom`,
//        `replayFromRound`).
//
//   Both gates are currently absent → the inner expects throw → the
//   test fails → `test.fail` flips it to a passing expected-failure.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import {
    bootstrapCustomBackend,
    appendConnectionProfile,
    markOnboarded,
} from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: ['*ack*'] });
    server = await startServer({ batchKey: 'orchestrator', scenarioId: '76-rerun-step-n' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#76 — Re-run from step N', () => {
    test('RunStateStore round-recording API: appendRound + getCurrentRun expose the round list a rerun feature would target', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Smoke: the store APIs that a "re-run from step N" feature
        // would build on top of are present and produce ordered rounds.
        const result = await page.evaluate(async () => {
            const mod = await import('/scripts/extensions/orchestrator/run-state/store.js');
            mod.clearCurrentRun();
            const runId = mod.startRun({ mode: 'director', chatKey: 'k', abortFn: null });

            // Simulate 4 rounds of work.
            for (let i = 0; i < 4; i++) {
                mod.appendRound({
                    runId,
                    round: {
                        id: `main-${i}`,
                        label: `Step ${i}`,
                        kind: 'main',
                        sections: [],
                        status: 'completed',
                    },
                });
            }
            const r = mod.getCurrentRun();
            const roundIds = r.rounds.map(x => x.id);
            mod.clearCurrentRun();
            return { roundIds };
        });

        expect(result.roundIds).toEqual(['main-0', 'main-1', 'main-2', 'main-3']);
    });

    // The next two tests are documentation of a product gap. They are
    // expected to fail today; `test.fail()` flips a passing test into a
    // failure, so the moment the feature lands and these assertions start
    // passing, Playwright will surface them as "unexpected pass" and the
    // developer is forced to remove the `test.fail()` annotation.
    test.fail('GAP: a completed run exposes a per-round rerun affordance via the run panel UI or a slash command', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Build a completed 4-round director run, then mount the panel.
        const panelInfo = await page.evaluate(async () => {
            const mod = await import('/scripts/extensions/orchestrator/run-state/store.js');
            const panel = await import('/scripts/extensions/orchestrator/run-panel/panel.js');

            mod.clearCurrentRun();
            const runId = mod.startRun({ mode: 'director', chatKey: 'rerun-from-step-n', abortFn: null });
            for (let i = 0; i < 4; i++) {
                mod.appendRound({
                    runId,
                    round: {
                        id: `step-${i}`,
                        label: `Step ${i}: scout sweep`,
                        kind: 'main',
                        sections: [],
                        status: 'completed',
                    },
                });
            }
            mod.finishRun({ runId, status: 'committed', finalText: 'final guidance' });

            panel.openRunPanel?.({});
            // Give the renderer a tick to paint rounds.
            await new Promise(r => requestAnimationFrame(() => r()));

            const root = document.getElementById('luker-orch-run-panel');
            const headerActions = root
                ? [...root.querySelectorAll('.panel-actions [data-action]')].map(b => b.dataset.action)
                : [];
            // Look for ANY per-round affordance the feature would expose:
            //   - a button on the round item, OR
            //   - a data-action like "rerun-from-here" / "replay-from"
            const roundEls = root ? [...root.querySelectorAll('[data-round-id]')] : [];
            const perRoundButtons = roundEls.flatMap(li => [
                ...li.querySelectorAll('button[data-action], [data-orch-round-action]'),
            ]).map(el => el.getAttribute('data-action') || el.getAttribute('data-orch-round-action') || '');

            // Look for a slash command. The orchestrator registers none today.
            const ctx = window.Luker.getContext();
            const knownCommandNames = Array.isArray(ctx?.SlashCommandParser?.commands)
                ? ctx.SlashCommandParser.commands.map(c => String(c?.name || ''))
                : Object.keys(ctx?.SlashCommandParser?.commands || {});
            const orchRerunCmd = knownCommandNames.find(n => /^orch.*(rerun|replay|restart)/i.test(n)) || null;

            mod.clearCurrentRun();
            return { headerActions, perRoundButtons, orchRerunCmd };
        });

        // Either path satisfies the contract — UI affordance OR slash command.
        const hasUiAffordance = panelInfo.perRoundButtons.length > 0;
        const hasSlashCommand = Boolean(panelInfo.orchRerunCmd);
        expect(
            hasUiAffordance || hasSlashCommand,
            `expected per-round rerun UI or orch rerun/replay slash command; saw header=[${panelInfo.headerActions.join(',')}], perRound=[${panelInfo.perRoundButtons.join(',')}], slash=${panelInfo.orchRerunCmd}`,
        ).toBe(true);
    });

    test.fail('GAP: a public API truncates rounds at index k and reopens the run for re-execution from k+1', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Probe the RunStateStore module for any rerun/truncate API a
        // feature would expose. Naming convention is open; we accept any
        // of the obvious shapes.
        const apiInfo = await page.evaluate(async () => {
            const mod = await import('/scripts/extensions/orchestrator/run-state/store.js');
            const candidates = [
                'rerunFromRound',
                'replayFromRound',
                'restartFromRound',
                'truncateRoundsFrom',
                'truncateAtRound',
                'resumeRun',
            ];
            const present = candidates.filter(name => typeof mod[name] === 'function');
            // Also accept any other export whose name strongly suggests
            // round-level rerun/replay/restart.
            const allExports = Object.keys(mod);
            const suggestive = allExports.filter(name =>
                /(rerun|replay|restart|resume|truncate).*round/i.test(name)
                || /round.*(rerun|replay|restart|resume|truncate)/i.test(name),
            );
            return { present, suggestive, allExports };
        });

        const found = new Set([...apiInfo.present, ...apiInfo.suggestive]);
        expect(
            found.size,
            `expected RunStateStore to export a rerun/truncate-at-round API; saw exports=[${apiInfo.allExports.join(',')}]`,
        ).toBeGreaterThan(0);
    });
});
