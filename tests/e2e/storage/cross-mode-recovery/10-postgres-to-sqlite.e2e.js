// e2e/storage/cross-mode-recovery/10-postgres-to-sqlite.e2e.js

import { test } from '../../../harness/playwright.js';

import { runCrossModeRecoveryFlow } from './_lib/recovery-flow.js';

test('cross-mode recovery: postgres → sqlite preserves chat through engine swap', async ({ resources, page }) => {
    const tempDir = (await resources.directory('xmode-postgres-to-sqlite')).path;
    {
        await runCrossModeRecoveryFlow({ scope: resources,
            page, sourceMode: 'postgres', destMode: 'sqlite', specId: '10-postgres-to-sqlite', tempDir,
        });
    }
});
