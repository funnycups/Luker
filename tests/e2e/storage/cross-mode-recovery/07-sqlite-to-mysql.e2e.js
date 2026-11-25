// e2e/storage/cross-mode-recovery/07-sqlite-to-mysql.e2e.js

import { test } from '../../../harness/playwright.js';

import { runCrossModeRecoveryFlow } from './_lib/recovery-flow.js';

test('cross-mode recovery: sqlite → mysql preserves chat through engine swap', async ({ resources, page }) => {
    const tempDir = (await resources.directory('xmode-sqlite-to-mysql')).path;
    {
        await runCrossModeRecoveryFlow({ scope: resources,
            page, sourceMode: 'sqlite', destMode: 'mysql', specId: '07-sqlite-to-mysql', tempDir,
        });
    }
});
