// e2e/storage/cross-mode-recovery/01-fs-to-sqlite.e2e.js
//
// End-to-end test for the fs → sqlite cross-mode recovery flow. Uses real
// Playwright + a real server + the real Backup Manager UI: NO mocks except
// the LLM (per the LLM-is-only-legitimate-mock convention).
//
// No docker required for this pair — both engines are file-based.

import { test } from '../../../harness/playwright.js';

import { runCrossModeRecoveryFlow } from './_lib/recovery-flow.js';

test('cross-mode recovery: fs → sqlite preserves chat through engine swap', async ({ resources, page }) => {
    const tempDir = (await resources.directory('xmode-fs-to-sqlite')).path;
    {
        await runCrossModeRecoveryFlow({ scope: resources,
            page,
            sourceMode: 'fs',
            destMode: 'sqlite',
            specId: '01-fs-to-sqlite',
            tempDir,
        });
    }
});
