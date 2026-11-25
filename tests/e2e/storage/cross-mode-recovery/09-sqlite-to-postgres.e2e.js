// e2e/storage/cross-mode-recovery/09-sqlite-to-postgres.e2e.js

import { test } from '../../../harness/playwright.js';

import { runCrossModeRecoveryFlow } from './_lib/recovery-flow.js';

test('cross-mode recovery: sqlite → postgres preserves chat through engine swap', async ({ resources, page }) => {
    const tempDir = (await resources.directory('xmode-sqlite-to-postgres')).path;
    {
        await runCrossModeRecoveryFlow({ scope: resources,
            page, sourceMode: 'sqlite', destMode: 'postgres', specId: '09-sqlite-to-postgres', tempDir,
        });
    }
});
