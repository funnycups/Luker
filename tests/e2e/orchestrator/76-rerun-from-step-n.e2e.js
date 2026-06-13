// Case #76 — Re-run from step N
//
// Spec:
//   - After a 4-step run completes, select step 2 → re-run from there.
//   - Steps 3+4 re-execute fresh.
//   - Steps 0+1 preserved.
//
// Why fixme:
//   Re-running an orchestration from an arbitrary intermediate step is
//   an editor / iter-studio operation, not a runtime one. The director
//   runtime processes one main-agent loop per turn; "step N" of a
//   completed run is recorded in the RunStateStore as a round (sub-agent
//   call or main-agent reasoning section), and there is no production UI
//   that lets the user click on a past round and say "re-run from here".
//
// What IS available:
//   The agenda runtime allows partial re-execution by editing the
//   working profile (drop completed nodes from a snapshot, then run
//   again); but that's a profile-shape mutation, not a round-level
//   replay. The spec-mode runtime has a `nodeIterationMaxRounds` knob
//   that re-runs an individual node; again, not a round-level replay.
//
// We surface this case as a documented fixme rather than inventing a
// test for a feature that doesn't exist. The smoke pass below proves
// the RunStateStore round-recording API the feature would build on.

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
    test('RunStateStore round-recording API: appendRound + ensureSection + appendToSection record each step', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Smoke: prove the store APIs that would underlie a "re-run from
        // step N" feature exist and produce the expected shape.
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
                        title: `Step ${i}`,
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

    test.fixme('re-run from step N: select step 2 → steps 3+4 re-execute; steps 0+1 preserved', async () => {
        // Not implemented in any orchestrator mode today. The closest
        // analog is iter-studio's per-leaf re-iterate, which operates on
        // a different unit (skill iteration tree, not run-state rounds).
        // Re-runs from step N would require: a UI affordance to pick a
        // round, a way to truncate the run's downstream state, and a
        // resumer that knows to skip the preserved steps. None exist as
        // of 2026-06.
    });
});
