// e2e/storage/cross-mode-recovery/03-fs-to-mysql.e2e.js
//
// Requires Docker (testcontainers spins up a real mysql:8.0).

import { test } from '../../../harness/playwright.js';

import { runCrossModeRecoveryFlow } from './_lib/recovery-flow.js';

test('cross-mode recovery: fs → mysql preserves chat through engine swap', async ({ resources, page }) => {
    const tempDir = (await resources.directory('xmode-fs-to-mysql')).path;
    {
        await runCrossModeRecoveryFlow({ scope: resources,
            page, sourceMode: 'fs', destMode: 'mysql', specId: '03-fs-to-mysql', tempDir,
        });
    }
});
