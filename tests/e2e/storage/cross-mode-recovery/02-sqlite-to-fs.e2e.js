// e2e/storage/cross-mode-recovery/02-sqlite-to-fs.e2e.js

import { test } from '../../../harness/playwright.js';

import { runCrossModeRecoveryFlow } from './_lib/recovery-flow.js';

test('cross-mode recovery: sqlite → fs preserves chat through engine swap', async ({ resources, page }) => {
    const tempDir = (await resources.directory('xmode-sqlite-to-fs')).path;
    {
        await runCrossModeRecoveryFlow({ scope: resources,
            page,
            sourceMode: 'sqlite',
            destMode: 'fs',
            specId: '02-sqlite-to-fs',
            tempDir,
        });
    }
});
