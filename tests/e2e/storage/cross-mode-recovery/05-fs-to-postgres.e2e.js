// e2e/storage/cross-mode-recovery/05-fs-to-postgres.e2e.js

import { test } from '../../../harness/playwright.js';

import { runCrossModeRecoveryFlow } from './_lib/recovery-flow.js';

test('cross-mode recovery: fs → postgres preserves chat through engine swap', async ({ resources, page }) => {
    const tempDir = (await resources.directory('xmode-fs-to-postgres')).path;
    {
        await runCrossModeRecoveryFlow({ scope: resources,
            page, sourceMode: 'fs', destMode: 'postgres', specId: '05-fs-to-postgres', tempDir,
        });
    }
});
