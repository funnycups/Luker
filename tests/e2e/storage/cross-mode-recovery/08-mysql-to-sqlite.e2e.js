// e2e/storage/cross-mode-recovery/08-mysql-to-sqlite.e2e.js

import { test } from '../../../harness/playwright.js';

import { runCrossModeRecoveryFlow } from './_lib/recovery-flow.js';

test('cross-mode recovery: mysql → sqlite preserves chat through engine swap', async ({ resources, page }) => {
    const tempDir = (await resources.directory('xmode-mysql-to-sqlite')).path;
    {
        await runCrossModeRecoveryFlow({ scope: resources,
            page, sourceMode: 'mysql', destMode: 'sqlite', specId: '08-mysql-to-sqlite', tempDir,
        });
    }
});
