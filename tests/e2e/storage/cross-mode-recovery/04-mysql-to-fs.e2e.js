// e2e/storage/cross-mode-recovery/04-mysql-to-fs.e2e.js

import { test } from '../../../harness/playwright.js';

import { runCrossModeRecoveryFlow } from './_lib/recovery-flow.js';

test('cross-mode recovery: mysql → fs preserves chat through engine swap', async ({ resources, page }) => {
    const tempDir = (await resources.directory('xmode-mysql-to-fs')).path;
    {
        await runCrossModeRecoveryFlow({ scope: resources,
            page, sourceMode: 'mysql', destMode: 'fs', specId: '04-mysql-to-fs', tempDir,
        });
    }
});
