// e2e/storage/cross-mode-recovery/11-mysql-to-postgres.e2e.js

import { test } from '../../../harness/playwright.js';

import { runCrossModeRecoveryFlow } from './_lib/recovery-flow.js';

test('cross-mode recovery: mysql → postgres preserves chat through engine swap', async ({ resources, page }) => {
    const tempDir = (await resources.directory('xmode-mysql-to-postgres')).path;
    {
        await runCrossModeRecoveryFlow({ scope: resources,
            page, sourceMode: 'mysql', destMode: 'postgres', specId: '11-mysql-to-postgres', tempDir,
        });
    }
});
