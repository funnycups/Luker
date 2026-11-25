// e2e/storage/cross-mode-recovery/12-postgres-to-mysql.e2e.js

import { test } from '../../../harness/playwright.js';

import { runCrossModeRecoveryFlow } from './_lib/recovery-flow.js';

test('cross-mode recovery: postgres → mysql preserves chat through engine swap', async ({ resources, page }) => {
    const tempDir = (await resources.directory('xmode-postgres-to-mysql')).path;
    {
        await runCrossModeRecoveryFlow({ scope: resources,
            page, sourceMode: 'postgres', destMode: 'mysql', specId: '12-postgres-to-mysql', tempDir,
        });
    }
});
