// e2e/storage/cross-mode-recovery/06-postgres-to-fs.e2e.js

import { test } from '../../../harness/playwright.js';

import { runCrossModeRecoveryFlow } from './_lib/recovery-flow.js';

test('cross-mode recovery: postgres → fs preserves chat through engine swap', async ({ resources, page }) => {
    const tempDir = (await resources.directory('xmode-postgres-to-fs')).path;
    {
        await runCrossModeRecoveryFlow({ scope: resources,
            page, sourceMode: 'postgres', destMode: 'fs', specId: '06-postgres-to-fs', tempDir,
        });
    }
});
