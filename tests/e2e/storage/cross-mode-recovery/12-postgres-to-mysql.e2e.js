// e2e/storage/cross-mode-recovery/12-postgres-to-mysql.e2e.js

import { test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCrossModeRecoveryFlow } from './_lib/recovery-flow.js';

test('cross-mode recovery: postgres → mysql preserves chat through engine swap', async ({ page }) => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'xmode-postgres-to-mysql-'));
    try {
        await runCrossModeRecoveryFlow({
            page, sourceMode: 'postgres', destMode: 'mysql', specId: '12-postgres-to-mysql', tempDir,
        });
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
});
